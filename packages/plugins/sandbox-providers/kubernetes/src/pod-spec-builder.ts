import { CONTAINER_MIN_RESOURCES } from "./tenant-orchestrator.js";
// The agent's working directory: a subdirectory of the /workspace emptyDir,
// not the mount itself. Kubernetes creates an emptyDir root as root:fsGroup
// (2777), and Git refuses a worktree whose top level another user owns
// ("detected dubious ownership"); runtime git has no global or system config
// to hold a safe.directory exception. The init container below creates it as
// the run user before the agent container starts, so every sync, exec and git
// command finds a directory the run user owns.
export const WORKSPACE_DIR = "/workspace/run";

/** Creates {@link WORKSPACE_DIR} as uid 1000 before the agent container runs. */
export function workspaceInitContainer(image: string): Record<string, unknown> {
  return {
    name: "workspace-dir",
    image,
    imagePullPolicy: "IfNotPresent",
    command: ["/bin/sh", "-c", `mkdir -p ${WORKSPACE_DIR}`],
    securityContext: {
      runAsNonRoot: true,
      runAsUser: 1000,
      runAsGroup: 1000,
      readOnlyRootFilesystem: true,
      allowPrivilegeEscalation: false,
      capabilities: { drop: ["ALL"] },
    },
    // The tenant LimitRange minimum is also the most this one mkdir needs.
    resources: { requests: { ...CONTAINER_MIN_RESOURCES }, limits: { ...CONTAINER_MIN_RESOURCES } },
    volumeMounts: [{ name: "workspace", mountPath: "/workspace" }],
  };
}

export interface BuildJobManifestInput {
  namespace: string;
  jobName: string;
  adapterType: string;
  image: string;
  envSecretName: string;
  serviceAccountName: string;
  labels: Record<string, string>;
  resources: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
  runtimeClassName?: string;
  activeDeadlineSec: number;
  ttlSecondsAfterFinished: number;
  imagePullSecrets?: string[];
  nodeSelector?: Record<string, string>;
}

export function buildJobManifest(input: BuildJobManifestInput): Record<string, unknown> {
  const podLabels = {
    ...input.labels,
    "paperclip.io/role": "agent",
  };
  return {
    apiVersion: "batch/v1",
    kind: "Job",
    metadata: {
      name: input.jobName,
      namespace: input.namespace,
      labels: { ...input.labels },
    },
    spec: {
      backoffLimit: 0,
      ttlSecondsAfterFinished: input.ttlSecondsAfterFinished,
      activeDeadlineSeconds: input.activeDeadlineSec,
      template: {
        metadata: { labels: podLabels },
        spec: {
          serviceAccountName: input.serviceAccountName,
          // Agent containers call back to paperclip-server via HTTPS egress;
          // they never call the Kubernetes API, so mounting an SA token is
          // unnecessary attack surface.
          automountServiceAccountToken: false,
          restartPolicy: "Never",
          ...(input.runtimeClassName ? { runtimeClassName: input.runtimeClassName } : {}),
          ...(input.imagePullSecrets && input.imagePullSecrets.length > 0
            ? { imagePullSecrets: input.imagePullSecrets.map((name) => ({ name })) }
            : {}),
          ...(input.nodeSelector && Object.keys(input.nodeSelector).length > 0
            ? { nodeSelector: { ...input.nodeSelector } }
            : {}),
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            runAsGroup: 1000,
            fsGroup: 1000,
            fsGroupChangePolicy: "OnRootMismatch",
            seccompProfile: { type: "RuntimeDefault" },
          },
          initContainers: [workspaceInitContainer(input.image)],
          containers: [
            {
              name: "agent",
              image: input.image,
              imagePullPolicy: "IfNotPresent",
              command: ["/usr/bin/tini", "--", "/usr/local/bin/paperclip-agent-shim"],
              // HOME must point at a writable mount; the image's default
              // HOME is inside the readOnly root filesystem. Agent runtimes
              // can silently exit with code 0 and no output when HOME is
              // unwritable, so set this explicitly.
              env: [{ name: "HOME", value: "/home/paperclip" }],
              envFrom: [{ secretRef: { name: input.envSecretName } }],
              securityContext: {
                runAsNonRoot: true,
                runAsUser: 1000,
                runAsGroup: 1000,
                readOnlyRootFilesystem: true,
                allowPrivilegeEscalation: false,
                capabilities: { drop: ["ALL"] },
              },
              resources: {
                requests: input.resources.requests ?? { cpu: "250m", memory: "512Mi" },
                limits: input.resources.limits ?? { cpu: "2", memory: "4Gi" },
              },
              volumeMounts: [
                { name: "workspace", mountPath: "/workspace" },
                { name: "home", mountPath: "/home/paperclip" },
                { name: "cache", mountPath: "/home/paperclip/.cache" },
                { name: "tmp", mountPath: "/tmp" },
              ],
            },
          ],
          volumes: [
            { name: "workspace", emptyDir: { sizeLimit: "8Gi" } },
            { name: "home", emptyDir: { sizeLimit: "1Gi" } },
            { name: "cache", emptyDir: { sizeLimit: "1Gi" } },
            { name: "tmp", emptyDir: { sizeLimit: "2Gi" } },
          ],
        },
      },
    },
  };
}
