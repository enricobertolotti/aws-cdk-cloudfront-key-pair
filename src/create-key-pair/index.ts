import { CloudFormationCustomResourceEvent } from 'aws-lambda';
import {
  SecretsManager,
  type ReplicaRegionType,
} from '@aws-sdk/client-secrets-manager';
import { generateKeyPairSync } from 'crypto';
import * as https from 'node:https';

export interface CreateKeyPairResourceProperties {
  readonly Name: string;
  readonly Description: string;
  readonly SecretRegions?: string[];
}

const secretsManager = new SecretsManager();

export const handler = async (
  event: CloudFormationCustomResourceEvent,
): Promise<void> => {
  const props =
    event.ResourceProperties as unknown as CreateKeyPairResourceProperties;

  switch (event.RequestType) {
    case 'Create': {
      await createKeyPair(event, props);
      break;
    }

    case 'Delete': {
      await deleteKeyPair(event, props);
      break;
    }
  }
};

async function sendResponse(
  event: CloudFormationCustomResourceEvent,
  status: string,
  data?: {
    [key: string]: any;
  },
  reason?: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const response: unknown | any = {
      Status: status,
      PhysicalResourceId: event.ResourceProperties.Name,
      StackId: event.StackId,
      RequestId: event.RequestId,
      LogicalResourceId: event.LogicalResourceId,
      Data: data,
    };
    if (reason) {
      response.Reason = reason;
    }

    const url = new URL(event.ResponseURL);
    const body = JSON.stringify(response);

    https
      .request({
        hostname: url.hostname,
        port: 443,
        path: `${url.pathname}${url.search}`,
        method: 'PUT',
        headers: {
          'content-type': '',
          'content-length': body.length,
        },
      })
      .on('error', reject)
      .on('response', (response) => {
        response.resume();

        if (response.statusCode && response.statusCode >= 400) {
          reject(
            new Error(
              `Server returned error ${response.statusCode}: ${response.statusMessage}`,
            ),
          );
        } else {
          resolve();
        }
      })
      .end(body, 'utf-8');
  });
}

async function createKeyPair(
  event: CloudFormationCustomResourceEvent,
  props: CreateKeyPairResourceProperties,
): Promise<void> {
  try {
    const { publicKey, privateKey } = generateKeyPair();

    console.log(publicKey);

    const publicKeyArn = await saveSecret(
      `${props.Name}/public`,
      publicKey.toString(),
      `${props.Description} (Public Key)`,
      props.SecretRegions,
    );

    const privateKeyArn = await saveSecret(
      `${props.Name}/private`,
      privateKey.toString(),
      `${props.Description} (Private Key)`,
      props.SecretRegions,
    );

    console.log(publicKeyArn);
    console.log(privateKeyArn);

    await sendResponse(event, 'SUCCESS', {
      PublicKey: publicKey.toString(),
      PublicKeyArn: publicKeyArn,
      PrivateKeyArn: privateKeyArn,
    });
  } catch (err: unknown | any) {
    console.error(err);

    await sendResponse(
      event,
      'FAILED',
      undefined,
      `${event.RequestType} failed`,
    );
  }
}

function generateKeyPair(): {
  publicKey: string | Buffer;
  privateKey: string | Buffer;
} {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });

  return {
    publicKey: publicKey.export({
      type: 'spki',
      format: 'pem',
    }),
    privateKey: privateKey.export({
      type: 'pkcs1',
      format: 'pem',
    }),
  };
}

function getSecretReplicaRegions(
  regions?: string[] | undefined,
): ReplicaRegionType[] | undefined {
  return regions?.map((region) => {
    return {
      Region: region,
    };
  });
}

async function saveSecret(
  secretId: string,
  secretString: string,
  description: string,
  regions?: string[] | undefined,
): Promise<string> {
  const { ARN } = await secretsManager.createSecret({
    Name: secretId,
    Description: description,
    SecretString: secretString,
    AddReplicaRegions: getSecretReplicaRegions(regions),
  });

  if (!ARN) {
    throw new Error(`ARN for Secrets Manager secret ${secretId} not found.`);
  }

  return ARN;
}

async function deleteKeyPair(
  event: CloudFormationCustomResourceEvent,
  props: CreateKeyPairResourceProperties,
): Promise<void> {
  try {
    const publicKeyArn = await deleteKeySecret(`${props.Name}/public`);
    const privateKeyArn = await deleteKeySecret(`${props.Name}/private`);

    await sendResponse(event, 'SUCCESS', {
      PublicKeyArn: publicKeyArn,
      PrivateKeyArn: privateKeyArn,
    });
  } catch (err: unknown | any) {
    console.error(err);

    await sendResponse(
      event,
      'FAILED',
      undefined,
      `${event.RequestType} failed`,
    );
  }
}

async function deleteKeySecret(secretId: string): Promise<string | undefined> {
  if (await secretExists(secretId)) {
    const { ARN } = await secretsManager.deleteSecret({
      SecretId: secretId,
      ForceDeleteWithoutRecovery: true,
    });

    return ARN;
  }
}

async function secretExists(secretId: string): Promise<boolean> {
  const { SecretList } = await secretsManager.listSecrets({
    Filters: [{ Key: 'name', Values: [secretId] }],
  });

  return !!SecretList && SecretList?.length > 0;
}
