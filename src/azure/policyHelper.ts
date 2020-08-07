import * as path from 'path';
import * as core from '@actions/core';
import { AzHttpClient } from './azHttpClient';
import { doesFileExist, getFileJson, getAllJsonFilesPath } from '../utils/fileHelper';
import { getObjectHash } from '../utils/hashUtils'

export const DEFINITION_TYPE = "Microsoft.Authorization/policyDefinitions";
export const ASSIGNMENT_TYPE = "Microsoft.Authorization/policyAssignments";
export const POLICY_OPERATION_CREATE = "CREATE";
export const POLICY_OPERATION_UPDATE = "UPDATE";
const POLICY_RESULT_FAILED = "FAILED";
const POLICY_RESULT_SUCCEEDED = "SUCCEEDED";
const POLICY_FILE_NAME = "policy.json";
const POLICY_RULES_FILE_NAME = "policy.rules.json";
const POLICY_PARAMETERS_FILE_NAME = "policy.parameters.json";

export interface PolicyRequest {
  path: string;
  type: string;
  operation: string;
}

export interface PolicyRequest2 {
  policy: any;
  operation: string;
}

export interface PolicyResult {
  path: string;
  type: string;
  operation: string;
  name: string;
  status: string;
  message: string;
}

export interface policyMetadata {
  policy_hash: string;
}

export function setResult(policyResults: PolicyResult[]): void {
  const failedCount: number = policyResults.filter(result => result.status === POLICY_RESULT_FAILED).length;
  if (failedCount > 0) {
    core.setFailed(`Found '${failedCount}' failure(s) while deploying policies.`);
  } else {
    core.info(`All policies deployed successfully. Created/updated '${policyResults.length}' definitions/assignments.`);
  }
}

export async function getAllPolicyRequests(paths: string[]): Promise<PolicyRequest2[]> {
  let policyRequests: PolicyRequest2[] = [];

  try {
    let allJsonFiles: string[] = getAllJsonFilesPath(paths);

    console.log("all json files : " + allJsonFiles);

    let policies: any[] = getAllPolicies(allJsonFiles);

    console.log(policies);
    
    const azHttpClient = new AzHttpClient();
    await azHttpClient.initialize();

    for (let policy of policies) {
      let githubHash = getObjectHash(policy);

      let azureMetadata: any;

      // TODO : Only update case handled. Need to handle create case

      if (policy.type == DEFINITION_TYPE) {
        let azDefinition = await azHttpClient.getPolicyDefinition(policy);
        azureMetadata = azDefinition.properties.metadata;
      }
      else {
        let azAssignment = await azHttpClient.getPolicyAssignment(policy);
        azureMetadata = azAssignment.properties.metadata;
      }

      console.log("azure metaData : " + JSON.stringify(azureMetadata));

      let updateRequired: boolean = false;

      if (azureMetadata.GitHubPolicy) {
        let azureHash: string = azureMetadata.GitHubPolicy.policy_hash;
        if (azureHash == githubHash) {
          console.log("Hash is same no need to update");
        }
        else {
          console.log("Hash is not same. We need to update.");
          updateRequired = true;
        }
      }
      else {
        console.log("Github metaData is not present. Will need to update");
        updateRequired = true;
      }

      if (updateRequired) {
        policyRequests.push(getPolicyRequest(policy, githubHash, POLICY_OPERATION_UPDATE));
      }
    }    
  }
  catch(error) {
    return Promise.reject(error);
  }

  return Promise.resolve(policyRequests);
}

export async function createOrUpdatePolicyObjects(azHttpClient: AzHttpClient, policyRequests: PolicyRequest[]): Promise<PolicyResult[]> {
  let policyResults: PolicyResult[] = [];
  for (const policyRequest of policyRequests) {
    let policyResult: PolicyResult = {
      path: policyRequest.path,
      type: policyRequest.type,
      operation: policyRequest.operation,
      name: '',
      status: '',
      message: ''
    };

    const isCreate: boolean = policyRequest.operation == POLICY_OPERATION_CREATE;
    switch (policyRequest.type) {
      case DEFINITION_TYPE:
        try {
          const definition: any = getPolicyDefinition(policyRequest.path);
          validateDefinition(definition);
          policyResult.name = definition.name;
          await azHttpClient.createOrUpdatePolicyDefinition(definition);
          policyResult.status = POLICY_RESULT_SUCCEEDED;
          policyResult.message = `Policy definition ${ isCreate ? 'created': 'updated' } successfully`;
          console.log(`${policyResult.message}. Path: ${policyRequest.path}`);
        }
        catch(error) {
          policyResult.status = POLICY_RESULT_FAILED;
          policyResult.message = `An error occured while ${isCreate ? 'creating' : 'updating' } policy defition. Error: ${error}`;
          console.log(`${policyResult.message}. Path: ${policyRequest.path}`);
        }

        policyResults.push(policyResult);
        break;

      case ASSIGNMENT_TYPE:
        try {
          const assignment: any = getPolicyAssignment(policyRequest.path);
          validateAssignment(assignment);
          policyResult.name = assignment.name;
          await azHttpClient.createOrUpdatePolicyAssignment(assignment);
          policyResult.status = POLICY_RESULT_SUCCEEDED;
          policyResult.message = `Policy assignment ${isCreate ? 'created' : 'updated'} successfully`;
          console.log(`${policyResult.message}. Path: ${policyRequest.path}`);
        }
        catch (error) {
          policyResult.status = POLICY_RESULT_FAILED;
          policyResult.message = `An error occured while ${isCreate ? 'creating' : 'updating' } policy assignment. Error: ${error}`;
          console.log(`${policyResult.message}. Path: ${policyRequest.path}`);
        }

        policyResults.push(policyResult);
        break;
    }
  }

  return Promise.resolve(policyResults);
}

function getPolicyDefinition(definitionPath: string): any {
  const policyPath = path.join(definitionPath, POLICY_FILE_NAME);
  const policyRulesPath = path.join(definitionPath, POLICY_RULES_FILE_NAME);
  const policyParametersPath = path.join(definitionPath, POLICY_PARAMETERS_FILE_NAME);

  let definition = getFileJson(policyPath);

  if ((!definition.properties || !definition.properties.policyRule) && doesFileExist(policyRulesPath)) {
    const policyRuleJson = getFileJson(policyRulesPath);
    if (policyRuleJson && policyRuleJson.policyRule) {
      if (!definition.properties) {
        // If properties is missing from the definition object and we obtain policyRule from the
        // policy rules file, add properties.
        definition.properties = {};
      }

      definition.properties.policyRule = policyRuleJson.policyRule;
    }
  }

  if ((!definition.properties || !definition.properties.parameters) && doesFileExist(policyParametersPath)) {
    const policyParametersJson = getFileJson(policyParametersPath);
    if (policyParametersJson && policyParametersJson.parameters) {
      if (!definition.properties) {
        // If properties is missing from the definition object and we obtain parameters from the
        // policy parameters file, add properties.
        definition.properties = {};
      }

      definition.properties.parameters = policyParametersJson.parameters;
    }
  }

  return definition;
}

function getPolicyAssignment(assignmentPath: string): any {
  return getFileJson(assignmentPath);
}

function validateDefinition(definition: any): void {
  if (!definition.id) {
    throw Error('Property id is missing from the policy definition. Please add id to the policy.json file.');
  }

  if (!definition.name) {
    throw Error('Property name is missing from the policy definition. Please add name to the policy.json file.');
  }
}

function validateAssignment(assignment: any): void {
  if (!assignment.id) {
    throw Error('Property id is missing from the policy assignment. Please add id to the assignment file.');
  }

  if (!assignment.name) {
    throw Error('Property name is missing from the policy assignment. Please add name to the assignment file.');
  }
}

// Returns all policy definition, assgnments present in the given paths.
function getAllPolicies(jsonPaths: string[]): any[] {
  let policies: any[] = [];

  jsonPaths.forEach((path) => {
    let policy = getPolicyObject(path);
    if (policy) {
      policies.push(policy);
    }
  });

  return policies;
}

function getPolicyObject(path: string): any {
  let jsonObj = getFileJson(path);

  // Todo : For DEFINITION_TYPE we need to check for parameter and rules files if required.

  if (jsonObj.type && jsonObj.type == ASSIGNMENT_TYPE || jsonObj.type == DEFINITION_TYPE) {
    return jsonObj;
  }

  return undefined;
}

function getWorkflowMetadata(policyHash: string): policyMetadata {
  let metadata: policyMetadata = {
    policy_hash: policyHash
  }

  return metadata;
}

function getPolicyRequest(policy: any, hash: string, operation: string): PolicyRequest2 {
  let metadata = getWorkflowMetadata(hash);
  if (!policy.properties.metadata) {
    policy.properties.metadata = {};
  }

  policy.properties.metadata.GitHubPolicy = metadata;

  return {
    policy: policy,
    operation: operation
  } as PolicyRequest2

}