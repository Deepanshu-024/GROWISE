import {Sandbox} from "@e2b/code-interpreter";

export async function getSandboxUrl(sandboxId: string) {
  const sandbox = await Sandbox.connect(sandboxId);
  return sandbox;
};