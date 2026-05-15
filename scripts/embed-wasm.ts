import { readFileSync, writeFileSync } from 'fs';

const wasmPath = './node_modules/jieba-wasm/pkg/web/jieba_rs_wasm_bg.wasm';
const outputPath = './src/core/jieba-wasm-embedded.ts';

const wasmBuffer = readFileSync(wasmPath);
const base64 = wasmBuffer.toString('base64');

const content = `/**
 * 自动生成的文件 - 不要手动修改
 * 由 scripts/embed-wasm.ts 生成
 */
export const JIEBA_WASM_BASE64 = "${base64}";

export function getJiebaWasmBytes(): Uint8Array {
  const binaryString = atob(JIEBA_WASM_BASE64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
}
`;

writeFileSync(outputPath, content);
console.log(`Generated ${outputPath} (${(base64.length / 1024 / 1024).toFixed(2)} MB)`);