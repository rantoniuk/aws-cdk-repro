import { Aws, CfnCapabilities, DefaultStackSynthesizer, Fn, Stack } from "aws-cdk-lib";
import { BuildSpec, LinuxBuildImage, PipelineProject } from "aws-cdk-lib/aws-codebuild";
import { Artifact, Pipeline } from "aws-cdk-lib/aws-codepipeline";
import {
  CloudFormationCreateUpdateStackAction,
  CodeBuildAction,
  S3SourceAction,
  S3Trigger,
} from "aws-cdk-lib/aws-codepipeline-actions";
import { IRole, Role } from "aws-cdk-lib/aws-iam";
import { IKey, Key } from "aws-cdk-lib/aws-kms";
import { Bucket, IBucket } from "aws-cdk-lib/aws-s3";
import { Construct } from "constructs";

export enum Accounts {
  DEVOPS = "506746435521",
  TEST = "769916547052",
}

export interface CdkConstructProps {
  encryptionKey: IKey;
  assetPrefix: string;
  sourceInput: Artifact;
  role: IRole;
  runOrder: number;
  monitoring: string;
}

export class DynamicPipelineStack extends Stack {
  constructor(scope: Construct, id: string) {
    super(scope, id);
    new PipelineConstruct(this, "TestPipeline");
  }
}

export class DynamicPipelineConstruct extends Construct {
  assetPrefix: string;

  // common pipeline role used for all CodePipeline and CodeBuild operations
  devOpsPipelineRole: IRole;

  // Roles for cross account deployments
  testDeployRole: IRole;
  testCfnExecRole: IRole;

  pipeline: Pipeline;
  sourceOutput: Artifact;
  artifactBucket: IBucket;
  encryptionKey: IKey;

  constructor(scope: Construct, id: string) {
    super(scope, id);

    // shared PipelineRole role from devops-infra stack to avoid having role per pipeline
    this.devOpsPipelineRole = Role.fromRoleArn(
      this,
      "pipelineRole",
      `arn:aws:iam::${Accounts.DEVOPS}:role/PipelineRole`,
      // { mutable: false },
    );

    // shared encryption key used for all objects stored in the bucket
    // at the moment unable to use SSE-S3 because of CDK limitations
    this.encryptionKey = Key.fromKeyArn(
      this,
      "pipelineArtifactKeyArn",
      Fn.importValue("sdg-pipeline-artifact-bucket-encryptionkeyArn"),
    );

    this.artifactBucket = Bucket.fromBucketAttributes(this, "cdkBucket", {
      // bucketArn: `arn:aws:s3:::cdk-${DefaultStackSynthesizer.DEFAULT_QUALIFIER}-assets-${Aws.ACCOUNT_ID}-${Aws.REGION}`,
      bucketArn: `arn:aws:s3:::cdk-${DefaultStackSynthesizer.DEFAULT_QUALIFIER}-assets-${Accounts.DEVOPS}-${Aws.REGION}`,
      encryptionKey: this.encryptionKey,
    });

    // Pipeline creation
    this.pipeline = new Pipeline(this, "TestPipeline", {
      pipelineName: `MyTestPipeline`,
      artifactBucket: this.artifactBucket,
      restartExecutionOnUpdate: true,
      role: this.devOpsPipelineRole,
    });

    this.sourceOutput = new Artifact();
    this.pipeline.addStage({
      stageName: "Source",
      actions: [
        new S3SourceAction({
          actionName: "SCM-source",
          bucket: Bucket.fromBucketName(this, "SourceBucket", "test-bucket-506746435521"),
          role: this.pipeline.role,
          bucketKey: "source.zip",
          output: this.sourceOutput,
          trigger: S3Trigger.NONE,
        }),
      ],
    });

    this.testDeployRole = Role.fromRoleArn(
      this,
      "testRole",
      `arn:aws:iam::${Accounts.TEST}:role/cdk-${DefaultStackSynthesizer.DEFAULT_QUALIFIER}-deploy-role-${Accounts.TEST}-eu-west-1`,
      { mutable: false },
    );

    this.testCfnExecRole = Role.fromRoleArn(
      this,
      "testCfnRole",
      `arn:aws:iam::${Accounts.TEST}:role/cdk-${DefaultStackSynthesizer.DEFAULT_QUALIFIER}-cfn-exec-role-${Accounts.TEST}-eu-west-1`,
      { mutable: false },
    );
  }
}

class CdkBuildConstruct extends Construct {
  artifact: Artifact;
  action: CodeBuildAction;

  constructor(scope: Construct, id: string, props: CdkConstructProps) {
    super(scope, id);

    this.artifact = new Artifact();
    const cdkBuild = new PipelineProject(this, id, {
      projectName: "CodeBuild",
      environment: { buildImage: LinuxBuildImage.STANDARD_5_0 },
      encryptionKey: props.encryptionKey,
      role: props.role,
      buildSpec: BuildSpec.fromObject({
        version: "0.2",
        phases: {
          install: {
            "runtime-versions": { nodejs: 14 },
            commands: [
              "aws --version",
              // "aws codeartifact login --tool npm --repository sdg-common-repository --domain sdg-repository --domain-owner 506746435521",
              "npx cdk --version",
              "cd cdk && npm ci && cd $CODEBUILD_SRC_DIR",
              "cd lambda && npm ci && cd $CODEBUILD_SRC_DIR",
              // "cd lambda/layer/nodejs && npm ci && cd $CODEBUILD_SRC_DIR",
            ],
          },
          build: {
            commands: [
              // lambda build needs to be first as cdk builds needs the produced assets
              "cd lambda && npm run build && cd $CODEBUILD_SRC_DIR",
              // nodejs doesn't need build command, it's node_modules dependencies only
              "cd cdk && npx cdk synth '*' && cd $CODEBUILD_SRC_DIR",
            ],
          },
        },
        artifacts: {
          "base-directory": "cdk/cdk.out",
          files: ["**/*"],
        },
      }),
    });

    this.action = new CodeBuildAction({
      runOrder: props.runOrder,
      actionName: id,
      project: cdkBuild,
      input: props.sourceInput,
      outputs: [this.artifact],
      role: props.role,
    });
  }
}

export class PipelineConstruct extends DynamicPipelineConstruct {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    const build = new CdkBuildConstruct(this, "CdkBuild", {
      runOrder: 1,
      encryptionKey: this.encryptionKey,
      assetPrefix: this.assetPrefix,
      sourceInput: this.sourceOutput,
      monitoring: "false",
      role: this.pipeline.role,
    });

    this.pipeline.addStage({
      stageName: "Build",
      actions: [build.action],
    });

    this.pipeline.addStage({
      stageName: "Deployment-DEV",
      actions: [
        new CloudFormationCreateUpdateStackAction({
          runOrder: 1,
          actionName: "DeployCF",
          stackName: "TestStack",
          adminPermissions: false,
          role: this.testDeployRole,
          // account: Accounts.TEST,
          // region: "eu-west-1",
          deploymentRole: this.testCfnExecRole,
          templatePath: build.artifact.atPath("TestStack.template.json"),
          cfnCapabilities: [CfnCapabilities.NAMED_IAM, CfnCapabilities.AUTO_EXPAND],
        }),
      ],
    });
  }
}
