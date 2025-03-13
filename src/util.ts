import { PathLike, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";

export function readdir_recursively(input: PathLike, only_files: boolean): string[] {
    let results = [] as string[];
    let stack = [input.toString()] as string[];

    while (stack.length > 0) {
        const current_path = stack.pop()!;
        const items = readdirSync(current_path);

        for (const item of items) {
            const full_path = join(current_path, item);
            const stats = lstatSync(full_path);

            if (stats.isSymbolicLink()) {
                continue;
            } else if (stats.isDirectory()) {
                stack.push(full_path);
            } else if (only_files && stats.isFile()) {
                results.push(full_path);
            } else if (!only_files) {
                results.push(full_path);
            }
        }
    }

    return results;
}

// https://gist.github.com/eplawless/52813b1d8ad9af510d85?permalink_comment_id=3367765#gistcomment-3367765
export function djb2Hash(str: string) {
    let len = str.length;
    let h = 5381;

    for (let i = 0; i < len; i++) {
        h = h * 33 ^ str.charCodeAt(i);
    }
    return h >>> 0;
}

export function diff_text(old_text: string, new_text: string, minimize: boolean) {
    const old_lines = old_text.split('\n');
    const new_lines = new_text.split('\n');

    const max_length = Math.max(old_lines.length, new_lines.length);
    let diff_result = [] as string[];

    let i = 0;
    let j = 0;

    while (i < old_lines.length || j < new_lines.length) {
        const old_line = old_lines[i] || '';
        const new_line = new_lines[j] || '';

        if (old_line !== new_line) {
            if (old_line && !new_lines.includes(old_line)) {
                if (minimize) {
                    diff_result.push(`- ${i + 1}: ${old_line}`);
                } else {
                    diff_result.push(`- ${i + 1}: ${old_line}`);
                }
                i++;
            } else if (new_line && !old_lines.includes(new_line)) {
                if (minimize) {
                    diff_result.push(`+ ${j + 1}: ${new_line}`);
                } else {
                    diff_result.push(`+ ${j + 1}: ${new_line}`);
                }
                j++;
            } else {
                if (minimize) {
                    diff_result.push(`- ${i + 1}: ${old_line}`);
                    diff_result.push(`+ ${j + 1}: ${new_line}`);
                } else {
                    diff_result.push(`- ${i + 1}: ${old_line}`);
                    diff_result.push(`+ ${j + 1}: ${new_line}`);
                }
                i++;
                j++;
            }
        } else {
            if (!minimize) {
                diff_result.push(`  ${i + 1}: ${old_line}`);
            }
            i++;
            j++;
        }
    }

    return diff_result;
}

export function get_deferred<T = any>() {
    let resolve: (value: T | PromiseLike<T>) => void;
    let reject: (reason?: any) => void;

    const promise = new Promise<T>((resolveCb, rejectCb) => {
        resolve = resolveCb;
        reject = rejectCb;
    });

    return { resolve: resolve!, reject: reject!, promise };
}

export function escape_regexp(string: string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
