import {
  convertSdocx,
  type ConversionOptions,
} from "@sdocx-importer/converter";
const scope = globalThis as unknown as {
  postMessage(message: unknown): void;
  onmessage:
    | ((
        event: MessageEvent<{ bytes: ArrayBuffer; options: ConversionOptions }>,
      ) => void)
    | null;
};
scope.onmessage = async ({ data }) => {
  try {
    const result = await convertSdocx(data.bytes, {
      ...data.options,
      onProgress: (progress) =>
        scope.postMessage({ type: "progress", progress }),
    });
    scope.postMessage({ type: "result", result });
  } catch (error) {
    scope.postMessage({
      type: "error",
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
scope.postMessage({ type: "ready" });
