/**
 * 中文分词模块
 * 使用 jieba-wasm 进行搜索引擎模式分词
 */
import { cut_for_search } from 'jieba-wasm';

/**
 * 对文本进行搜索引擎模式分词
 * cut_for_search 会输出多种粒度，召回率更高
 */
export async function tokenize(text: string): Promise<string[]> {
  return cut_for_search(text, true)
    .filter(w => w.trim() && !/^\p{P}+$/u.test(w));
}

/**
 * 将分词结果拼接为空格分隔的字符串，用于写入 tsvector
 */
export function toSegmentedText(tokens: string[]): string {
  return tokens.join(' ');
}

/**
 * 将分词结果拼接为 tsquery 格式（用 & 连接）
 */
export function toTsQueryText(tokens: string[]): string {
  return tokens.filter(w => w.trim()).join(' & ');
}