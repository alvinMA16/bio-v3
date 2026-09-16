declare module 'word-extractor' {
  export default class WordExtractor {
    extract(data: Buffer): Promise<{ getBody(): string }>;
  }
}
