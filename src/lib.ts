import { WriteStream } from "node:fs";
import { KeyUtil } from "./keys.ts";
import { diff_text, djb2Hash, get_deferred } from "./util.ts";
import { removeStopwords } from "stopword";

import { parse } from "@babel/parser";
import { jsxText, type JSXText, type Node, type Statement } from "@babel/types";
export enum AutomaticNamingMode {
    None = 0,
    Numeric = 1,
    Stopword = 2,
};

export type Options = {
    replacement: string;
    regex: RegExp;
    write: boolean;
    use_automatic_naming_mode: AutomaticNamingMode;
    output_path: string;
    lang: string;
    silent: boolean;
    key_length_limit: number;
};

function find_in_ast(body: Statement[], type: Node, first: boolean) {
    const final = [] as Node[];
    const state = {
        exit_now: false,
    };
    if (first) {
        final.push = (...args: typeof final[number][]) => {
            state.exit_now = true;
            return Array.prototype.push.call(final, ...args);
        };
    }
    for (let i = 0; i < body.length && !state.exit_now; i++) {
        if (body[i].type == type.type) {
            final.push(body[i]);
            continue;
        }
        const keys = Object.keys(body[i]);
        for (let key_index = 0; key_index < keys.length; key_index++) {
            const current_key = keys[key_index];
            if (body[i][current_key] !== null && typeof body[i][current_key] === "object" && typeof body[i][current_key].type === "string") {
                const result = find_in_ast([body[i][current_key]], type, first);
                if (result) {
                    final.push(...[result].flat());
                    continue;
                }
            }
            else {
                if (Array.isArray(body[i][current_key])) {
                    const result = find_in_ast(body[i][current_key], type, first);
                    if (result) {
                        final.push(...[result].flat());
                        continue;
                    }
                }
            }
        }
    }
    return first ? final[0] : final;
}

const NEWLINE = "\n";
const FILLER = `${NEWLINE}${new Array(4).fill(" ").join("")}`;

export async function execute(input: string, options: Options, lang_file_write_stream: WriteStream | null) { // write stream is null if output not specified
    const preloaded_lang = await (await import("stopword")).default[options.lang] as string[];
    const added_records = {} as { [key: string]: string };
    let modified_input = input;
    let counter = 0;

    const console_log = options.silent === true ? Function.prototype : console.log;

    let seed = djb2Hash(input);
    function random() {
        var x = Math.sin(seed++) * 10000;
        return x - Math.floor(x);
    }

    const calculate_replacement_using_strategy = async (text_fragment: string, mode: AutomaticNamingMode = options.use_automatic_naming_mode) => {
        switch (mode) {
            case AutomaticNamingMode.Numeric: {
                return "translation_key_" + Math.floor(random() * (counter + 2222));
            }
            case AutomaticNamingMode.None: {
                return await KeyUtil.ask("Context:\n\t" + text_fragment + "\nTranslation name (type \"-\" to skip):");
            }
            case AutomaticNamingMode.Stopword: {
                const res = removeStopwords(
                    text_fragment
                        .replace(/\r/g, "")
                        .replace(/\n/g, "")
                        .trim()
                        .toLowerCase()
                        .split(" ")
                        .map(x => x.trim()),
                    preloaded_lang
                ).filter(x => x.length > 0).filter((_, i) => i < options.key_length_limit).join("_")
                    .normalize("NFKD")
                    .replace(/[\u0300-\u036f]/g, "")
                    .replace(/ł/g, "l")
                    .replace(/[^A-Za-z\s_]/g, "");
                if (res.length < 4) {
                    return calculate_replacement_using_strategy(text_fragment, AutomaticNamingMode.None);
                }
                return res;
            }
        }
    };
    const replacements: { start: number; end: number; replacement: string }[] = [];

    const ast = parse(input, {
        sourceType: 'module',
        plugins: ['jsx', 'typescript'],
    });

    const text_nodes = find_in_ast(ast.program.body, jsxText(""), false) as JSXText[];
    if (text_nodes.length > 0) {
        for (let index = 0; index < text_nodes.length; index++) {
            const node = text_nodes[index];
            const text = node.value;

            if (text.trim().length === 0 || text.trim().length < 2) {
                continue;
            }

            let leading_whitespace = '';
            for (let i = node.start!; i < input.length; i++) {
                if (input[i] === ' ' || input[i] === '\t' || input[i] === '\n') {
                    leading_whitespace += input[i];
                } else {
                    break;
                }
            }
            const trailing_whitespace = text.substring(text.indexOf(text.trim()) + text.trim().length);
            const calculated = await calculate_replacement_using_strategy(text);
            if (calculated == "-") {
                counter++;
                continue;
            }
            const actual_replacement = options.replacement.replace("%name%", `"${calculated}"`);
            added_records[calculated] = text.trim();
            console_log("Applied", actual_replacement);

            const replacement = `${leading_whitespace}{${actual_replacement}}${trailing_whitespace}`;
            replacements.push({
                start: node.start!,
                end: node.end!,
                replacement
            });
            counter++;
        }
    }

    for (let i = replacements.length - 1; i >= 0; i--) {
        const { start, end, replacement } = replacements[i];
        modified_input =
            modified_input.substring(0, start) +
            replacement +
            modified_input.substring(end);
    }

    const show_diff = () => {
        const format = () => diff_text(input, modified_input, true).map(x => x.startsWith("+") ? ["\x1b[32m", x, "\x1b[0m\n"] : ["\x1b[31m", x, "\x1b[0m\n"]);
        console_log("", ...format().flat());
    }

    if (options.output_path === undefined || lang_file_write_stream === null) {
        console_log("Warn: Output file unspecified or invalid. Assuming dry run.");
        show_diff();
        return modified_input;
    }
    if (!options.write) {
        console_log("Dry run.");
        show_diff();
        return modified_input;
    }
    console_log("Writing.");
    show_diff();
    const stringify_records = () => {
        const result = { str: "" };

        const push_to_str = (chunk: string) => {
            result.str += chunk;
        };
        const prepared_value = (x: string) => {
            const raw = added_records[x]
                .trim()
                .replace(/\r/g, "");
            if (raw.split(NEWLINE).length > 1) {
                return raw.split(NEWLINE)
                    .map(x => x.trim())
                    .map((x, index) => index > 0 ? x : FILLER + x)
                    .join(FILLER)
            }
            return raw;
        };
        Object.keys(added_records).forEach(x =>
            push_to_str(`${x.trim()} = ${prepared_value(x)}${NEWLINE}`)); // TODO: allow user to specify the format
        return result.str;
    };
    const buffered_write = (data: any, cb: () => void) => {
        if (!lang_file_write_stream.write(data)) {
            lang_file_write_stream.once('drain', cb);
        } else {
            process.nextTick(cb);
        }
    }
    const write_finish_deferred = get_deferred<void>();
    buffered_write(stringify_records(), write_finish_deferred.resolve);
    await write_finish_deferred.promise;
    console_log("Finished writing.");
    return modified_input;
}
