export type EmbeddingBackend = 'node-llama-cpp';

export interface LiveEmbeddingResult {
    vector: number[];
    backend: EmbeddingBackend;
}

export interface EmbeddingResult {
    vector: number[];
    backend: EmbeddingBackend;
    cacheHit: boolean;
}
