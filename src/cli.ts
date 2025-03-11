import * as process from "node:process";
import { statSync, readdirSync, existsSync, readFileSync, WriteStream, createWriteStream } from "node:fs";
import { Options, AutomaticNamingMode, execute } from "./lib.ts";
import { get_deferred, readdir_recursively } from "./util.ts"
import { basename } from "node:path";

const example_commands = [
    '--write --replacement "$x(%name%)" --output out/eng.lang my-project/src/components/something.tsx',
    '--stopword --replacement "localize(%name%)" --output out/eng.lang my-project/src/'
];

type Option = {
    aliases: string[];
    result_key: keyof Options;
    param_count: number;
    default?: Options[keyof Options];
    parse?: (...args: string[]) => unknown;
    description: string;
}

function default_parse(this: Option, ...[arg, ...params]) {
    if (this.param_count == 0) {
        return true;
    }
    const used_params = params.slice(0, this.param_count);
    return this.param_count == 1 ? used_params.join() : used_params;
}

const options_map = [
    {
        aliases: ["--write", "-w"],
        result_key: "write",
        param_count: 0,
        description: "Sets whenever should the software write to file. If ommited, dry run is performed.",
    },
    {
        aliases: ["--replacement"],
        result_key: "replacement",
        param_count: 1,
        description: "Sets replacement string for processed lines. Use %name% to add placeholder which will be replaced with the target name.",
    },
    {
        aliases: ["--regex"],
        result_key: "regex",
        param_count: 1,
        description: "Unused, yet.",
    },
    {
        aliases: ["--stopword"],
        result_key: "use_automatic_naming_mode",
        param_count: 0,
        parse(...[arg]) {
            return AutomaticNamingMode.Stopword;
        },
        description: "Sets automatic naming mode to Stopword generation.",
    },
    {
        aliases: ["--numeric"],
        result_key: "use_automatic_naming_mode",
        param_count: 0,
        // default: true,
        parse(...[arg]) {
            return AutomaticNamingMode.Numeric;
        },
        description: "Sets automatic naming mode to numeric generation.",
    },
    {
        aliases: ["--manual"],
        result_key: "use_automatic_naming_mode",
        param_count: 0,
        default: true,
        parse(...[arg]) {
            return AutomaticNamingMode.None;
        },
        description: "Disables automatic naming mode, requiring the user to specify name for each string segment.",
    },
    {
        aliases: ["--output"],
        result_key: "output_path",
        param_count: 1,
        description: "Specifies the output file (your language registry file).",
    },
    {
        aliases: ["--lang"],
        result_key: "lang",
        param_count: 1,
        default: "eng",
        description: "Specifies the language of input files.",
    },
    {
        aliases: ["--quiet", "--silence"],
        result_key: "silent",
        param_count: 0,
        description: "If enabled, internal library will not print any logs to standard output.",
    }
] as Option[];

function parser(arg: string, rest: string[]) {
    if (!arg.startsWith("-"))
        return null;
    const found = options_map.find(x => x.aliases.includes(arg));
    if (!found) {
        console.warn("Warn: Unknown option", arg);
        return null;
    }
    const final = {
        result: {},
        offset: 0,
    };
    const key = found.result_key;
    if (found.parse == undefined) {
        const val = default_parse.call(found, ...[arg, ...rest]);
        final.result[key] = val;
    }
    else {
        const val = found.parse(...[arg, ...rest]);
        final.result[key] = val;
    }
    final.offset = found.param_count;
    console.log(final);
    return final;
}
function print_help(what: string) {
    console.log(what);
    console.log("Usage: [options] --output <output lang file> <input file/directory>");
    console.log("Options:");
    let longest = 0;
    options_map.forEach(el => {
        const len = el.aliases.join(", ").length;
        if (len > longest)
            longest = len;
    });
    for (let i = 0; i < options_map.length; i++) {
        const opt = options_map[i];
        const base = `  ${opt.aliases.join(", ")}`;
        console.log(`${base}${new Array(longest - (base.length - 2)).fill(" ").join("")}  ${opt.description}${opt.default === undefined ? "" : " (Default: " + (opt.default === true ? "enabled" : opt.default) + ")"}`);
    }
    console.log("Examples:");
    example_commands.forEach(el => console.log("  " + el))
}
function parse_args(args: string[]) {
    if (args.length == 0) {
        print_help("Error: Missing parameters.");
        return null;
    }
    const parsed_options = {} as Options;
    const unused_args = [] as string[];
    for (let i = 0; i < args.length; i++) {
        const result = parser(args[i], args.slice(i + 1));
        if (result != null) {
            i += result.offset;
            Object.assign(parsed_options, result.result);
        }
        else unused_args.push(args[i]);
    }
    // console.log(unused_args);
    for (let i = 0; i < options_map.length; i++) {
        const opt = options_map[i];
        if (parsed_options[opt.result_key] !== undefined) continue;
        if (opt.default !== undefined) {
            const temp = {};
            if (opt.parse == undefined) {
                const val = default_parse.call(opt, ...[opt.aliases[0], ...[]]);
                temp[opt.result_key] = val;
            }
            else {
                const val = opt.parse(...[opt.aliases[0], ...[]]);
                temp[opt.result_key] = val;
            }
            Object.assign(parsed_options, temp);
        }
    }
    return { input: unused_args[unused_args.length - 1], options: parsed_options };
}

async function entry() {
    const parsed = parse_args(process.argv.filter((_, i) => i > 1).map(x => x.toString()));
    if (parsed == null) {
        return 1;
    }
    const { input, options } = parsed;
    const state = {
        write_stream: null as WriteStream | null,
    };
    if (!existsSync(input)) {
        print_help("Error: input doesn't exist.");
        return 1;
    }
    if (options.replacement === undefined) {
        print_help("Error: missing replacement option.");
        return 1;
    }
    const st = statSync(input);
    const targets = [] as string[];
    if (st.isDirectory()) {
        targets.push(...readdir_recursively(input, true));
    }
    else {
        targets.push(input);
    }

    if (options.output_path !== undefined && existsSync(options.output_path) && statSync(options.output_path).isFile()) {
        state.write_stream = createWriteStream(options.output_path, { flags: "a" });
        const ready = get_deferred<void>();
        state.write_stream.once("ready", ready.resolve);
        await ready.promise;
    }

    for (let i = 0; i < targets.length; i++) {
        const file_content = readFileSync(targets[i], "utf8");
        await execute(file_content, options, state.write_stream);
    }
    if (state.write_stream !== null) {
        const closed = get_deferred<Error | null | undefined>();
        state.write_stream.close(closed.resolve);
        await closed.promise;
    }
    return 0;
}
process.exit(await entry());
