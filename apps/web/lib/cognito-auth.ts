import { config } from "./config";

function cognitoRegionFromUserPoolId(userPoolId: string): string {
  const [region] = userPoolId.split("_");
  if (!region) {
    throw new Error("Invalid Cognito user pool id");
  }

  return region;
}

interface InitiateAuthSuccess {
  AuthenticationResult?: {
    IdToken?: string;
    AccessToken?: string;
    RefreshToken?: string;
  };
  ChallengeName?: string;
}

interface CognitoError {
  message?: string;
  __type?: string;
}

export async function signInWithPassword(username: string, password: string): Promise<string> {
  if (!config.cognitoUserPoolId || !config.cognitoUserPoolClientId) {
    throw new Error("Cognito is not configured for this environment");
  }

  const region = cognitoRegionFromUserPoolId(config.cognitoUserPoolId);

  const response = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth"
    },
    body: JSON.stringify({
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: config.cognitoUserPoolClientId,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password
      }
    })
  });

  const payload = (await response.json()) as InitiateAuthSuccess | CognitoError;

  if (!response.ok) {
    const message =
      "message" in payload && typeof payload.message === "string"
        ? payload.message
        : "Authentication failed";
    throw new Error(message);
  }

  if ("ChallengeName" in payload && payload.ChallengeName) {
    throw new Error(`Unsupported Cognito challenge: ${payload.ChallengeName}`);
  }

  const idToken =
    "AuthenticationResult" in payload
      ? payload.AuthenticationResult?.IdToken
      : undefined;

  if (!idToken) {
    throw new Error("Missing IdToken from Cognito auth response");
  }

  window.localStorage.setItem("netpulse_token", idToken);
  return idToken;
}

export function signOut(): void {
  window.localStorage.removeItem("netpulse_token");
}
