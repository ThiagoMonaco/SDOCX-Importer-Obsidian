import {
  convertSdocx,
  type ConversionOptions,
  type ConversionResult,
  type Progress,
} from "@sdocx-importer/converter";

type WorkerRequest = {
  bytes: ArrayBuffer;
  options: Pick<
    ConversionOptions,
    "strokeScale" | "textLineHeight" | "pageFrames"
  >;
};

export type WorkerMessage =
  | { type: "ready" }
  | { type: "progress"; progress: Progress }
  | { type: "result"; result: ConversionResult }
  | { type: "error"; error: string };

function post(message: WorkerMessage): void {
  self.postMessage(message);
}

self.onmessage = ({ data }: MessageEvent<WorkerRequest>) => {
  void convertSdocx(data.bytes, {
    ...data.options,
    onProgress: (progress) => post({ type: "progress", progress }),
  })
    .then((result) => post({ type: "result", result }))
    .catch((error: unknown) => {
      post({
        type: "error",
        error: error instanceof Error ? error.message : String(error),
      });
    });
};
post({ type: "ready" });
