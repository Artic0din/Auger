// The subset of ICU MessageFormat that silo-translations allows in keys that reach Apple, Android and
// Roku: text, `{name}` arguments and `plural` with the CLDR categories, where `#` is the number.
// The catalog rejects `select`, `=N`, `offset`, typed arguments and tags for these keys, and rejects an
// ASCII apostrophe where ICU would read it as an escape, so a quote is always a literal quote here.

export type MessageNode =
    | { readonly kind: "text"; readonly text: string }
    | { readonly kind: "argument"; readonly name: string }
    | { readonly kind: "count" }
    | { readonly kind: "plural"; readonly name: string; readonly forms: Readonly<Record<string, readonly MessageNode[]>> };

export type MessageArgs = Readonly<Record<string, string | number>>;

const PLURAL_CATEGORIES: ReadonlySet<string> = new Set(["zero", "one", "two", "few", "many", "other"]);
const NAME = /\s*([A-Za-z][A-Za-z0-9_]*)\s*/y;
const SELECTOR = /\s*([^\s{}]+)\s*/y;
const SPACE = /(\s*)/y;

interface Reader { readonly text: string; at: number }

export function parseMessage(message: string): readonly MessageNode[] {
    const reader: Reader = { text: message, at: 0 };
    const nodes = parseNodes(reader, false);
    if (reader.at < message.length) throw new Error(`Unmatched } in message "${message}"`);
    return nodes;
}

function parseNodes(reader: Reader, inPlural: boolean): readonly MessageNode[] {
    const nodes: MessageNode[] = [];
    let text = "";
    const flush = (): void => {
        if (text !== "") nodes.push({ kind: "text", text });
        text = "";
    };
    while (reader.at < reader.text.length) {
        const char = reader.text.charAt(reader.at);
        if (char === "}") break;
        if (char === "{") {
            flush();
            reader.at++;
            nodes.push(parseArgument(reader));
        } else if (char === "#" && inPlural) {
            flush();
            nodes.push({ kind: "count" });
            reader.at++;
        } else {
            text += char;
            reader.at++;
        }
    }
    flush();
    return nodes;
}

function match(reader: Reader, pattern: RegExp, what: string): string {
    pattern.lastIndex = reader.at;
    const found = pattern.exec(reader.text);
    if (found === null || found[1] === undefined) throw new Error(`Expected ${what} at ${reader.at} in "${reader.text}"`);
    reader.at = pattern.lastIndex;
    return found[1];
}

function expect(reader: Reader, char: string, what: string): void {
    if (reader.text.charAt(reader.at) !== char) throw new Error(`${what} in "${reader.text}"`);
    reader.at++;
}

function parseArgument(reader: Reader): MessageNode {
    const name = match(reader, NAME, "an argument name");
    if (reader.text.charAt(reader.at) === "}") {
        reader.at++;
        return { kind: "argument", name };
    }
    expect(reader, ",", "Unclosed argument");
    const type = match(reader, NAME, "an argument type");
    if (type !== "plural") throw new Error(`Unsupported argument type ${type} in "${reader.text}"`);
    expect(reader, ",", "Unclosed plural");
    const forms: Record<string, readonly MessageNode[]> = {};
    for (;;) {
        match(reader, SPACE, "whitespace");
        if (reader.at >= reader.text.length) throw new Error(`Unclosed plural in "${reader.text}"`);
        if (reader.text.charAt(reader.at) === "}") break;
        const category = match(reader, SELECTOR, "a plural category");
        if (!PLURAL_CATEGORIES.has(category)) throw new Error(`Unsupported plural selector ${category} in "${reader.text}"`);
        expect(reader, "{", "Unclosed plural");
        forms[category] = parseNodes(reader, true);
        expect(reader, "}", "Unclosed plural form");
    }
    reader.at++;
    if (forms.other === undefined) throw new Error(`A plural needs an other form in "${reader.text}"`);
    return { kind: "plural", name, forms };
}

const numberFormats = new Map<string, Intl.NumberFormat>();
const pluralRules = new Map<string, Intl.PluralRules>();

function numberText(value: number, locale: string): string {
    let format = numberFormats.get(locale);
    if (format === undefined) numberFormats.set(locale, format = new Intl.NumberFormat(locale));
    return format.format(value);
}

function pluralCategory(value: number, locale: string): string {
    let rules = pluralRules.get(locale);
    if (rules === undefined) pluralRules.set(locale, rules = new Intl.PluralRules(locale));
    return rules.select(value);
}

/** Numbers print in `locale`'s digits and grouping, as Apple's `String(localized:)` prints an Int; strings print as given. */
export function formatMessage(nodes: readonly MessageNode[], args: MessageArgs, locale: string, count?: number): string {
    let out = "";
    for (const node of nodes) {
        if (node.kind === "text") {
            out += node.text;
        } else if (node.kind === "count") {
            out += numberText(count ?? 0, locale);
        } else if (node.kind === "argument") {
            const value = args[node.name];
            if (value === undefined) throw new Error(`Missing message argument ${node.name}`);
            out += typeof value === "number" ? numberText(value, locale) : value;
        } else {
            const value = args[node.name];
            if (typeof value !== "number") throw new Error(`Message argument ${node.name} must be a number`);
            const form = node.forms[pluralCategory(value, locale)] ?? node.forms.other;
            out += form === undefined ? "" : formatMessage(form, args, locale, value);
        }
    }
    return out;
}
