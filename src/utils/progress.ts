export interface ProgressReporter {
    tick(): void;
    done(): void;
}

const CLEAR_LINE = '\r\u001b[2K';

export function createProgressReporter(label: string, total: number, enabled: boolean): ProgressReporter {
    const interactive = enabled && total > 0 && Boolean(process.stderr.isTTY);
    let completed = 0;
    let rendered = false;

    return {
        tick(): void {
            completed += 1;
            if (!interactive) {
                return;
            }
            process.stderr.write(`${CLEAR_LINE}${label} ${completed}/${total}`);
            rendered = true;
        },
        done(): void {
            if (rendered) {
                process.stderr.write(CLEAR_LINE);
            }
        },
    };
}
