export const config = {
  apiBaseUrl: process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001",
  wsUrl: process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:3001/ws",
  cognitoUserPoolId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_ID ?? "",
  cognitoUserPoolClientId: process.env.NEXT_PUBLIC_COGNITO_USER_POOL_CLIENT_ID ?? "",
  demoOrgId: process.env.NEXT_PUBLIC_DEMO_ORG_ID ?? "org_demo_public"
};
