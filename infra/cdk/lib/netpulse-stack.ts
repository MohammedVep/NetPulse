import path from "node:path";
import { Duration, RemovalPolicy, Stack, type StackProps } from "aws-cdk-lib";
import { AttributeType, BillingMode, ProjectionType, Table } from "aws-cdk-lib/aws-dynamodb";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import {
  HttpApi,
  CorsHttpMethod,
  WebSocketApi,
  WebSocketStage,
  HttpMethod,
  CfnStage
} from "aws-cdk-lib/aws-apigatewayv2";
import { HttpLambdaIntegration, WebSocketLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import * as cognito from "aws-cdk-lib/aws-cognito";
import { Bucket, BucketEncryption, StorageClass } from "aws-cdk-lib/aws-s3";
import { Queue } from "aws-cdk-lib/aws-sqs";
import { Rule, Schedule } from "aws-cdk-lib/aws-events";
import { LambdaFunction as LambdaTarget } from "aws-cdk-lib/aws-events-targets";
import { SqsEventSource } from "aws-cdk-lib/aws-lambda-event-sources";
import { Topic } from "aws-cdk-lib/aws-sns";
import { RetentionDays } from "aws-cdk-lib/aws-logs";
import { Alarm, ComparisonOperator, TreatMissingData } from "aws-cdk-lib/aws-cloudwatch";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

interface NetPulseStackProps extends StackProps {
  envName: "dev" | "staging" | "prod";
}

export class NetPulseStack extends Stack {
  constructor(scope: Construct, id: string, props: NetPulseStackProps) {
    super(scope, id, props);

    const suffix = props.envName;

    const organizationsTable = new Table(this, "OrganizationsTable", {
      tableName: `np_organizations_${suffix}`,
      partitionKey: { name: "orgId", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }
    });

    const membershipsTable = new Table(this, "MembershipsTable", {
      tableName: `np_memberships_${suffix}`,
      partitionKey: { name: "orgId", type: AttributeType.STRING },
      sortKey: { name: "userId", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }
    });
    membershipsTable.addGlobalSecondaryIndex({
      indexName: "user-org-index",
      partitionKey: { name: "userId", type: AttributeType.STRING },
      sortKey: { name: "orgId", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL
    });

    const endpointsTable = new Table(this, "EndpointsTable", {
      tableName: `np_endpoints_${suffix}`,
      partitionKey: { name: "orgId", type: AttributeType.STRING },
      sortKey: { name: "endpointId", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }
    });
    endpointsTable.addGlobalSecondaryIndex({
      indexName: "org-status-index",
      partitionKey: { name: "orgId", type: AttributeType.STRING },
      sortKey: { name: "statusUpdatedAt", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL
    });

    const probeResultsTable = new Table(this, "ProbeResultsTable", {
      tableName: `np_probe_results_${suffix}`,
      partitionKey: { name: "probePk", type: AttributeType.STRING },
      sortKey: { name: "timestampIso", type: AttributeType.STRING },
      timeToLiveAttribute: "expiresAt",
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }
    });

    const incidentsTable = new Table(this, "IncidentsTable", {
      tableName: `np_incidents_${suffix}`,
      partitionKey: { name: "incidentPk", type: AttributeType.STRING },
      sortKey: { name: "openedAtIso", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }
    });
    incidentsTable.addGlobalSecondaryIndex({
      indexName: "org-state-index",
      partitionKey: { name: "orgId", type: AttributeType.STRING },
      sortKey: { name: "stateOpenedAt", type: AttributeType.STRING },
      projectionType: ProjectionType.ALL
    });

    const wsConnectionsTable = new Table(this, "WsConnectionsTable", {
      tableName: `np_ws_connections_${suffix}`,
      partitionKey: { name: "orgId", type: AttributeType.STRING },
      sortKey: { name: "connectionId", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: "expiresAt"
    });

    const alertChannelsTable = new Table(this, "AlertChannelsTable", {
      tableName: `np_alert_channels_${suffix}`,
      partitionKey: { name: "orgId", type: AttributeType.STRING },
      sortKey: { name: "channelId", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }
    });

    const alertDedupeTable = new Table(this, "AlertDedupeTable", {
      tableName: `np_alert_dedupe_${suffix}`,
      partitionKey: { name: "dedupeKey", type: AttributeType.STRING },
      timeToLiveAttribute: "expiresAt",
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.RETAIN,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true }
    });

    const reportsBucket = new Bucket(this, "ReportsBucket", {
      bucketName: `np-reports-${suffix}-${this.account}`,
      encryption: BucketEncryption.S3_MANAGED,
      lifecycleRules: [
        {
          transitions: [{ storageClass: StorageClass.GLACIER, transitionAfter: Duration.days(180) }]
        }
      ],
      removalPolicy: RemovalPolicy.RETAIN,
      autoDeleteObjects: false
    });

    const probeDlq = new Queue(this, "ProbeDlq", {
      queueName: `np-probe-dlq-${suffix}`,
      retentionPeriod: Duration.days(14)
    });

    const probeJobsQueue = new Queue(this, "ProbeJobsQueue", {
      queueName: `np-probe-jobs-${suffix}`,
      visibilityTimeout: Duration.seconds(120),
      deadLetterQueue: {
        maxReceiveCount: 3,
        queue: probeDlq
      }
    });

    const incidentEventsQueue = new Queue(this, "IncidentEventsQueue", {
      queueName: `np-incident-events-${suffix}`,
      visibilityTimeout: Duration.seconds(120)
    });

    const wsEventsQueue = new Queue(this, "WsEventsQueue", {
      queueName: `np-ws-events-${suffix}`,
      visibilityTimeout: Duration.seconds(120)
    });

    const emailTopic = new Topic(this, "EmailAlertsTopic", {
      topicName: `np-alerts-email-${suffix}`
    });

    const userPool = new cognito.UserPool(this, "NetPulseUserPool", {
      userPoolName: `np-users-${suffix}`,
      selfSignUpEnabled: false,
      signInAliases: {
        email: true
      },
      standardAttributes: {
        email: {
          required: true,
          mutable: true
        }
      }
    });

    const userPoolClient = new cognito.UserPoolClient(this, "NetPulseUserPoolClient", {
      userPool,
      authFlows: {
        userPassword: true,
        userSrp: true
      }
    });

    const apiRuntime = Runtime.NODEJS_20_X;
    const repositoryRoot = path.resolve(process.cwd(), "../..");
    const depsLockFilePath = path.join(repositoryRoot, "package-lock.json");

    const apiRest = new NodejsFunction(this, "ApiRestLambda", {
      functionName: `np-api-rest-${suffix}`,
      runtime: apiRuntime,
      entry: path.join(repositoryRoot, "services/api/src/handlers/rest.ts"),
      handler: "handler",
      depsLockFilePath,
      projectRoot: repositoryRoot,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20"
      },
      timeout: Duration.seconds(20),
      memorySize: 512,
      logRetention: RetentionDays.THREE_MONTHS,
      environment: {
        ORGANIZATIONS_TABLE: organizationsTable.tableName,
        MEMBERSHIPS_TABLE: membershipsTable.tableName,
        ENDPOINTS_TABLE: endpointsTable.tableName,
        PROBE_RESULTS_TABLE: probeResultsTable.tableName,
        INCIDENTS_TABLE: incidentsTable.tableName,
        WS_CONNECTIONS_TABLE: wsConnectionsTable.tableName,
        ALERT_CHANNELS_TABLE: alertChannelsTable.tableName,
        ENDPOINT_LIMIT_DEFAULT: "2000",
        PUBLIC_DEMO_ENABLED: "true",
        PUBLIC_DEMO_ORG_ID: "org_demo_public"
      }
    });

    const apiWebsocket = new NodejsFunction(this, "ApiWebsocketLambda", {
      functionName: `np-api-ws-${suffix}`,
      runtime: apiRuntime,
      entry: path.join(repositoryRoot, "services/api/src/handlers/websocket.ts"),
      handler: "handler",
      depsLockFilePath,
      projectRoot: repositoryRoot,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20"
      },
      timeout: Duration.seconds(20),
      memorySize: 512,
      logRetention: RetentionDays.THREE_MONTHS,
      environment: {
        MEMBERSHIPS_TABLE: membershipsTable.tableName,
        WS_CONNECTIONS_TABLE: wsConnectionsTable.tableName,
        ALLOW_UNAUTHENTICATED_WS: suffix === "dev" ? "true" : "false",
        COGNITO_USER_POOL_ID: userPool.userPoolId,
        COGNITO_USER_POOL_CLIENT_ID: userPoolClient.userPoolClientId
      }
    });

    const scheduler = new NodejsFunction(this, "SchedulerLambda", {
      functionName: `np-scheduler-${suffix}`,
      runtime: apiRuntime,
      entry: path.join(repositoryRoot, "services/prober/src/handlers/scheduler.ts"),
      handler: "handler",
      depsLockFilePath,
      projectRoot: repositoryRoot,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20"
      },
      timeout: Duration.seconds(60),
      memorySize: 512,
      logRetention: RetentionDays.THREE_MONTHS,
      environment: {
        ORGANIZATIONS_TABLE: organizationsTable.tableName,
        ENDPOINTS_TABLE: endpointsTable.tableName,
        PROBE_JOBS_QUEUE_URL: probeJobsQueue.queueUrl
      }
    });

    const worker = new NodejsFunction(this, "ProbeWorkerLambda", {
      functionName: `np-probe-worker-${suffix}`,
      runtime: apiRuntime,
      entry: path.join(repositoryRoot, "services/prober/src/handlers/worker.ts"),
      handler: "handler",
      depsLockFilePath,
      projectRoot: repositoryRoot,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20"
      },
      timeout: Duration.seconds(60),
      memorySize: 1024,
      logRetention: RetentionDays.THREE_MONTHS,
      environment: {
        ENDPOINTS_TABLE: endpointsTable.tableName,
        PROBE_RESULTS_TABLE: probeResultsTable.tableName,
        INCIDENTS_TABLE: incidentsTable.tableName,
        INCIDENT_EVENTS_QUEUE_URL: incidentEventsQueue.queueUrl,
        WS_EVENTS_QUEUE_URL: wsEventsQueue.queueUrl
      }
    });

    const notifier = new NodejsFunction(this, "IncidentNotifierLambda", {
      functionName: `np-incident-notifier-${suffix}`,
      runtime: apiRuntime,
      entry: path.join(repositoryRoot, "services/prober/src/handlers/notifier.ts"),
      handler: "handler",
      depsLockFilePath,
      projectRoot: repositoryRoot,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20"
      },
      timeout: Duration.seconds(30),
      memorySize: 512,
      logRetention: RetentionDays.THREE_MONTHS,
      environment: {
        ALERT_CHANNELS_TABLE: alertChannelsTable.tableName,
        ALERT_DEDUPE_TABLE: alertDedupeTable.tableName,
        EMAIL_TOPIC_ARN: emailTopic.topicArn
      }
    });

    const wsBroadcaster = new NodejsFunction(this, "WsBroadcasterLambda", {
      functionName: `np-ws-broadcaster-${suffix}`,
      runtime: apiRuntime,
      entry: path.join(repositoryRoot, "services/prober/src/handlers/ws-broadcaster.ts"),
      handler: "handler",
      depsLockFilePath,
      projectRoot: repositoryRoot,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20"
      },
      timeout: Duration.seconds(30),
      memorySize: 512,
      logRetention: RetentionDays.THREE_MONTHS,
      environment: {
        WS_CONNECTIONS_TABLE: wsConnectionsTable.tableName
      }
    });

    const monthlyExporter = new NodejsFunction(this, "MonthlyExporterLambda", {
      functionName: `np-monthly-exporter-${suffix}`,
      runtime: apiRuntime,
      entry: path.join(repositoryRoot, "services/prober/src/handlers/monthly-exporter.ts"),
      handler: "handler",
      depsLockFilePath,
      projectRoot: repositoryRoot,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20"
      },
      timeout: Duration.seconds(300),
      memorySize: 1024,
      logRetention: RetentionDays.THREE_MONTHS,
      environment: {
        ORGANIZATIONS_TABLE: organizationsTable.tableName,
        PROBE_RESULTS_TABLE: probeResultsTable.tableName,
        MONTHLY_REPORTS_BUCKET: reportsBucket.bucketName
      }
    });

    organizationsTable.grantReadWriteData(apiRest);
    membershipsTable.grantReadWriteData(apiRest);
    endpointsTable.grantReadWriteData(apiRest);
    probeResultsTable.grantReadData(apiRest);
    incidentsTable.grantReadData(apiRest);
    wsConnectionsTable.grantReadWriteData(apiWebsocket);
    membershipsTable.grantReadData(apiWebsocket);
    alertChannelsTable.grantReadWriteData(apiRest);
    apiRest.addToRolePolicy(
      new PolicyStatement({
        actions: ["secretsmanager:CreateSecret", "secretsmanager:TagResource"],
        resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:netpulse/*`]
      })
    );

    organizationsTable.grantReadData(scheduler);
    endpointsTable.grantReadData(scheduler);
    probeJobsQueue.grantSendMessages(scheduler);

    endpointsTable.grantReadWriteData(worker);
    probeResultsTable.grantReadWriteData(worker);
    incidentsTable.grantReadWriteData(worker);
    incidentEventsQueue.grantSendMessages(worker);
    wsEventsQueue.grantSendMessages(worker);

    alertChannelsTable.grantReadData(notifier);
    alertDedupeTable.grantReadWriteData(notifier);
    emailTopic.grantPublish(notifier);
    notifier.addToRolePolicy(
      new PolicyStatement({
        actions: ["secretsmanager:GetSecretValue"],
        resources: [`arn:aws:secretsmanager:${this.region}:${this.account}:secret:netpulse/*`]
      })
    );

    wsConnectionsTable.grantReadWriteData(wsBroadcaster);

    organizationsTable.grantReadData(monthlyExporter);
    probeResultsTable.grantReadData(monthlyExporter);
    reportsBucket.grantPut(monthlyExporter);

    worker.addEventSource(new SqsEventSource(probeJobsQueue, { batchSize: 10, reportBatchItemFailures: true }));
    notifier.addEventSource(
      new SqsEventSource(incidentEventsQueue, { batchSize: 10, reportBatchItemFailures: true })
    );
    wsBroadcaster.addEventSource(new SqsEventSource(wsEventsQueue, { batchSize: 10, reportBatchItemFailures: true }));

    new Rule(this, "ProbeScheduleRule", {
      schedule: Schedule.rate(Duration.minutes(5)),
      targets: [new LambdaTarget(scheduler)]
    });

    new Rule(this, "MonthlyExportRule", {
      schedule: Schedule.cron({
        minute: "15",
        hour: "0",
        day: "1"
      }),
      targets: [new LambdaTarget(monthlyExporter)]
    });

    const httpApi = new HttpApi(this, "NetPulseHttpApi", {
      apiName: `np-http-${suffix}`,
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [
          CorsHttpMethod.GET,
          CorsHttpMethod.POST,
          CorsHttpMethod.PATCH,
          CorsHttpMethod.DELETE,
          CorsHttpMethod.OPTIONS
        ],
        allowHeaders: ["authorization", "content-type"]
      }
    });

    const defaultHttpStage = httpApi.defaultStage?.node.defaultChild as CfnStage | undefined;
    if (defaultHttpStage) {
      defaultHttpStage.defaultRouteSettings = {
        throttlingBurstLimit: 200,
        throttlingRateLimit: 100
      };
    }

    const jwtAuthorizer = new HttpJwtAuthorizer(
      "NetPulseJwtAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      {
        jwtAudience: [userPoolClient.userPoolClientId]
      }
    );

    const restIntegration = new HttpLambdaIntegration("NetPulseRestIntegration", apiRest);

    httpApi.addRoutes({
      path: "/v1/{proxy+}",
      methods: [HttpMethod.GET, HttpMethod.POST, HttpMethod.PATCH, HttpMethod.DELETE],
      integration: restIntegration,
      authorizer: jwtAuthorizer
    });

    httpApi.addRoutes({
      path: "/v1/public/{proxy+}",
      methods: [HttpMethod.GET],
      integration: restIntegration
    });

    const wsApi = new WebSocketApi(this, "NetPulseWebSocketApi", {
      apiName: `np-ws-${suffix}`,
      connectRouteOptions: {
        integration: new WebSocketLambdaIntegration("ConnectIntegration", apiWebsocket)
      },
      disconnectRouteOptions: {
        integration: new WebSocketLambdaIntegration("DisconnectIntegration", apiWebsocket)
      },
      defaultRouteOptions: {
        integration: new WebSocketLambdaIntegration("DefaultIntegration", apiWebsocket)
      }
    });

    wsApi.addRoute("subscribe", {
      integration: new WebSocketLambdaIntegration("SubscribeIntegration", apiWebsocket)
    });

    wsApi.addRoute("unsubscribe", {
      integration: new WebSocketLambdaIntegration("UnsubscribeIntegration", apiWebsocket)
    });

    const wsStage = new WebSocketStage(this, "NetPulseWebSocketStage", {
      webSocketApi: wsApi,
      stageName: "prod",
      autoDeploy: true
    });

    wsBroadcaster.addEnvironment("WEBSOCKET_ENDPOINT", wsStage.url.replace("wss://", "https://"));
    wsApi.grantManageConnections(wsBroadcaster);

    new Alarm(this, "ProbeQueueAgeAlarm", {
      metric: probeJobsQueue.metricApproximateAgeOfOldestMessage(),
      threshold: 120,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING
    });

    new Alarm(this, "WorkerErrorsAlarm", {
      metric: worker.metricErrors(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING
    });

    new Alarm(this, "ApiErrorsAlarm", {
      metric: apiRest.metricErrors(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING
    });

    new Alarm(this, "WsBroadcasterErrorsAlarm", {
      metric: wsBroadcaster.metricErrors(),
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING
    });

    this.exportValue(httpApi.url!, { name: `NetPulseHttpApiUrl-${suffix}` });
    this.exportValue(wsStage.url, { name: `NetPulseWebSocketUrl-${suffix}` });
    this.exportValue(userPool.userPoolId, { name: `NetPulseUserPoolId-${suffix}` });
    this.exportValue(userPoolClient.userPoolClientId, { name: `NetPulseUserPoolClientId-${suffix}` });
    this.exportValue(emailTopic.topicArn, { name: `NetPulseEmailTopicArn-${suffix}` });
  }
}
