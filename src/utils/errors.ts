export function hasErrorCode(error: unknown, code: string): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === code;
}

export function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
