import { Stack, StackProps } from "aws-cdk-lib";
import { Code, Function, Runtime } from "aws-cdk-lib/aws-lambda";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import { Bucket } from "aws-cdk-lib/aws-s3";
import { BucketDeployment, Source } from "aws-cdk-lib/aws-s3-deployment";
import { Construct } from "constructs";
import path = require("path");

export class TestStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    const bucket = Bucket.fromBucketName(this, "bucket", "sdg-dummy");

    new BucketDeployment(this, "deployment", {
      sources: [Source.asset("./assets")],
      destinationBucket: bucket,
      destinationKeyPrefix: "assets",
    });

    // lambda
    const lambdaCode = Code.fromAsset(path.normalize("../lambda/dist/"));

    new Function(this, "function", {
      functionName: id,
      runtime: Runtime.NODEJS_14_X,
      logRetention: RetentionDays.THREE_MONTHS,
      code: lambdaCode,
      handler: "index.lambdaHandler",
    });
  }
}
