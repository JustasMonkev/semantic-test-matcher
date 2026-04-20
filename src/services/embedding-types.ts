export type EmbeddingBackend =
    | 'hf'
    | 'ollama-embeddings'
    | 'ollama-generate'
    | 'local-text-vector';

export interface LiveEmbeddingResult {
    vector: number[];
    backend: EmbeddingBackend;
    fallbackReason?: string;
}

export interface EmbeddingResult {
    vector: number[];
    backend: EmbeddingBackend;
    cacheHit: boolean;
    fallbackReason?: string;
}

export function isStableEmbeddingBackend(backend: EmbeddingBackend): boolean {
    return backend === 'hf' || backend === 'ollama-embeddings';
}
