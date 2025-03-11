import { WriteStream } from "node:fs";
import { KeyUtil } from "./keys.ts";
import { diff_text, djb2Hash, get_deferred } from "./util.ts";
import { removeStopwords } from "stopword";

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
};

// const default_regex = /\s*?([\w\s!.łóćęążźć,śń]+?)\s*?</g;
// const default_regex = /\s*?([\w\s!.łóćęążźć,śń]+?)({" "})*?\s*?</g; // TODO: Enhance this
const default_regex = /\s*?([A-Za-z\s!.łóćęążźć,śń]+?)({" "})*?\s*?</g; // TODO: Enhance this

function split_into_JSX_blocks(input: string) {
    const blocks: { block: string; start: number }[] = [];
    let startIndex = 0;
    let depth = 0;
    let inJSX = false;
    let inJSExpression = false;

    for (let i = 0; i < input.length; i++) {
        if (input[i] === '<' && !inJSX && !inJSExpression) {
            inJSX = true;
            depth++;
        } else if (input[i] === '<' && inJSX && !inJSExpression) {
            depth++;
        } else if (input[i] === '>' && inJSX && !inJSExpression) {
            depth--;
            if (depth === 0) {
                inJSX = false;
                blocks.push({ block: input.substring(startIndex, i + 1), start: startIndex });
                startIndex = i + 1;
            }
        } else if (input[i] === '{' && inJSX) {
            inJSExpression = true;
        } else if (input[i] === '}' && inJSX) {
            inJSExpression = false;
        }
    }

    if (startIndex < input.length) {
        blocks.push({ block: input.substring(startIndex), start: startIndex });
    }

    return blocks;
}

const NEWLINE = "\n";
const FILLER = `${NEWLINE}${new Array(4).fill(" ").join("")}`;

export async function execute(input: string, options: Options, lang_file_write_stream: WriteStream | null) { // write stream is null if output not specified
    const preloaded_lang = await (await import("stopword")).default[options.lang] as string[];
    const jsx_blocks = split_into_JSX_blocks(input);
    const added_records = {} as { [key: string]: string };
    let modified_input = input;
    let counter = 0;

    const console_log = options.silent === true ? Function.prototype : console.log;

    let seed = djb2Hash(input);
    function random() {
        var x = Math.sin(seed++) * 10000;
        return x - Math.floor(x);
    }

    const calculate_replacement_using_strategy = async (text_fragment: string) => {
        switch (options.use_automatic_naming_mode) {
            case AutomaticNamingMode.Numeric: {
                return "translation_key_" + Math.floor(random() * (counter + 2222));
            }
            case AutomaticNamingMode.None: {
                return await KeyUtil.ask("Context:\n\t" + text_fragment + "\nTranslation name (type \"-\" to skip):");
            }
            case AutomaticNamingMode.Stopword: {
                return removeStopwords(
                    text_fragment
                        .replace(/\r/g, "")
                        .replace(/\n/g, "")
                        .trim()
                        .toLowerCase()
                        .split(" ")
                        .map(x => x.trim()),
                    preloaded_lang
                ).filter(x => x.length > 0).join("_")
                    .normalize("NFKD")
                    .replace(/[\u0300-\u036f]/g, "")
                    .replace(/ł/g, "l")
                    .replace(/[^A-Za-z\s_]/g, "");
            }
        }
    };
    const replacements: { start: number; end: number; replacement: string }[] = [];

    for (let index = 0; index < jsx_blocks.length; index++) {
        const { block, start: block_start } = jsx_blocks[index];
        let result: RegExpExecArray | null;

        while ((result = default_regex.exec(block)) !== null) {
            if (result[1].trim().length === 0 || result[1].trim().length < 2) {
                continue;
            }

            const text = result[1];
            const match_start = result.index;
            const match_end = match_start + result[0].length;

            const absolute_start = block_start + match_start;
            const absolute_end = block_start + match_end;

            const full_match = result[0];
            let leading_whitespace = '';
            for (let i = absolute_start; i < input.length; i++) {
                if (input[i] === ' ' || input[i] === '\t' || input[i] === '\n') {
                    leading_whitespace += input[i];
                } else {
                    break;
                }
            }
            const trailing_whitespace = full_match.substring(full_match.indexOf(text) + text.length);
            const calculated = await calculate_replacement_using_strategy(text);
            if (calculated == "-") {
                counter++;
                continue;
            }
            const actual_replacemenet = options.replacement.replace("%name%", `"${calculated}"`);
            added_records[calculated] = text.trim();
            console_log("Applied", actual_replacemenet);
            const replacement = `${leading_whitespace}{${actual_replacemenet}}${trailing_whitespace}`;

            replacements.push({ start: absolute_start, end: absolute_end, replacement });
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
