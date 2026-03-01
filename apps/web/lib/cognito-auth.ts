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

interface SignUpSuccess {
  UserConfirmed: boolean;
}

interface CognitoError {
  message?: string;
  __type?: string;
}

interface CognitoRequestOptions {
  target: string;
  body: Record<string, unknown>;
}

async function cognitoRequest<T>(options: CognitoRequestOptions): Promise<T> {
  if (!config.cognitoUserPoolId || !config.cognitoUserPoolClientId) {
    throw new Error("Cognito is not configured for this environment");
  }

  const region = cognitoRegionFromUserPoolId(config.cognitoUserPoolId);

  const response = await fetch(`https://cognito-idp.${region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": options.target
    },
    body: JSON.stringify(options.body)
  });

  const payload = (await response.json()) as unknown;

  if (!response.ok) {
    const errorPayload = payload as CognitoError;
    const message =
      typeof errorPayload.message === "string"
        ? errorPayload.message
        : "Cognito request failed";
    throw new Error(message);
  }

  return payload as T;
}

export async function signInWithPassword(username: string, password: string): Promise<string> {
  const payload = await cognitoRequest<InitiateAuthSuccess>({
    target: "AWSCognitoIdentityProviderService.InitiateAuth",
    body: {
      AuthFlow: "USER_PASSWORD_AUTH",
      ClientId: config.cognitoUserPoolClientId,
      AuthParameters: {
        USERNAME: username,
        PASSWORD: password
      }
    }
  });

  if (payload.ChallengeName) {
    throw new Error(`Unsupported Cognito challenge: ${payload.ChallengeName}`);
  }

  const idToken = payload.AuthenticationResult?.IdToken;

  if (!idToken) {
    throw new Error("Missing IdToken from Cognito auth response");
  }

  window.localStorage.setItem("netpulse_token", idToken);
  return idToken;
}

export async function signUpWithPassword(email: string, password: string): Promise<{ userConfirmed: boolean }> {
  const payload = await cognitoRequest<SignUpSuccess>({
    target: "AWSCognitoIdentityProviderService.SignUp",
    body: {
      ClientId: config.cognitoUserPoolClientId,
      Username: email,
      Password: password,
      UserAttributes: [
        {
          Name: "email",
          Value: email
        }
      ]
    }
  });

  return {
    userConfirmed: payload.UserConfirmed
  };
}

export async function confirmSignUp(email: string, code: string): Promise<void> {
  await cognitoRequest({
    target: "AWSCognitoIdentityProviderService.ConfirmSignUp",
    body: {
      ClientId: config.cognitoUserPoolClientId,
      Username: email,
      ConfirmationCode: code
    }
  });
}

export async function resendSignUpCode(email: string): Promise<void> {
  await cognitoRequest({
    target: "AWSCognitoIdentityProviderService.ResendConfirmationCode",
    body: {
      ClientId: config.cognitoUserPoolClientId,
      Username: email
    }
  });
}

export function signOut(): void {
  window.localStorage.removeItem("netpulse_token");
}
