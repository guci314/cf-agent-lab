// 两个执行后端（Judge0 公共实例 / 自建 executor）共用的契约。
//
// 抽出来是因为 `run_python` 上面那一层（截断、超时提示、hint）不该关心代码
// 到底跑在谁家 —— 换后端只换下面这一层。
//
// 为什么要两个后端：Judge0 公共实例**服务端禁止联网**（实测传 enable_network
// 直接返回 "enabling network is not allowed"），所以它装不了包、也跑不了
// openai-agents 这类要出网的库。自建 executor 把固定依赖烤进镜像、并且允许
// 出网，代价是多一个要运维的东西。

export interface RunResult {
  /** 脚本是否正常跑完（**不看退出码** —— 非零退出也算跑完了） */
  ok: boolean;
  /** 后端自己的状态码，已对齐到下面两个常量 */
  statusId: number;
  status: string;
  /** 非零退出码、或后端给的失败原因，常常就藏在这里 */
  message: string | null;
  stdout: string;
  stderr: string;
  timeSec: string | null;
  memoryKb: number | null;
}

export interface RunRequest {
  code: string;
  stdin?: string;
  /** 会以原名出现在工作目录里 */
  files?: { name: string; data: Uint8Array }[];
  cpuTimeLimit: number;
  wallTimeLimit: number;
  memoryLimitKb: number;
  /** 本地这一侧的等待上限，要**大于** wallTimeLimit + 排队时间 */
  timeoutMs: number;
}

/** 跑完了 */
export const STATUS_ACCEPTED = 3;
/** 超时。两个后端都归到这个码，`hint` 靠它判断 */
export const STATUS_TIMEOUT = 5;
