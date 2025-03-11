export class KeyUtil {
    public static async ask(question: string): Promise<string> {
        const buf = new Uint8Array(1024);
        await Deno.stdout.write(new TextEncoder().encode(`${question} `));
        const n = await Deno.stdin.read(buf);
        if (n === null) return "";
        return new TextDecoder().decode(buf.subarray(0, n)).trim();
    }
}
