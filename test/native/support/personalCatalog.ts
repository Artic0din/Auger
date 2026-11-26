// The personal-list fake: a catalog that keeps watchlist and favorites membership itself, so a card's state follows what a page changes.
import assert from "node:assert/strict";
import { FakeDetails } from "./fakeDetails.ts";
import { problem, type Reply } from "./fakeSilo.ts";

export class PersonalCatalog extends FakeDetails {
    readonly excluded = new Set<string>();
    private readonly membershipState = new Map<string, Set<string>>();
    unavailable = false;
    capabilityReplies: Reply[] = [];
    pageReplies: Reply[] = [];
    override route(method: string, path: string, profile: string | undefined, body?: Record<string, unknown>): Reply | undefined {
        if (path.startsWith("/capabilities/personal-lists")) return this.capabilityReplies.shift() ?? { status: 200, body: { revision: "1", state: this.unavailable ? "unsupported" : "available", allowed: !this.unavailable, membership_supported: true } };
        const list = /^\/(watchlist|favorites)\?/.exec(path);
        if (method === "GET" && list?.[1] !== undefined) {
            const params = new URLSearchParams(path.split("?")[1]);
            assert.equal(params.get("limit"), "24");
            return this.route("POST", "/catalog/query", profile, { source: list[1], type: "video", limit: 24, ...(params.has("cursor") ? { cursor: params.get("cursor") } : {}) });
        }
        const personal = /^\/(watchlist|favorites)\/([^/?]+)(?:\/membership)?(?:\?.*)?$/.exec(path);
        if (personal?.[1] !== undefined && personal[2] !== undefined) {
            const members = this.members(profile, personal[1]);
            const id = decodeURIComponent(personal[2]);
            if (method === "GET") return { status: 200, body: { item_id: id, is_member: members.has(id) } };
            const reply = super.route(method, path, profile, body);
            if (reply?.status === 204) {
                if (method === "DELETE") members.delete(id);
                else members.add(id);
            }
            return reply;
        }
        if (path.startsWith("/catalog/query") && typeof body?.source === "string" && ["watchlist", "favorites", "history"].includes(body.source)) {
            assert.equal(method, "POST");
            const limit = body.source === "history" ? 60 : 24;
            assert.equal(body.limit, limit);
            const failure = this.pageReplies.shift();
            if (failure !== undefined) return failure;
            const scope = `${profile}:${body.source}:${body.type}`;
            // Unset scope queries media_items; episode history aggregates into series there.
            const scoped = [...this.titles.values()].filter(t => (profile === "p-kid" ? t.libraryId === "16" : ["12", "13", "14"].includes(t.libraryId)) && (body.type === undefined || body.type === "video" ? ["movie", "series", "audiobook"].includes(t.type) : t.type === body.type));
            const members = body.source === "history" ? undefined : this.members(profile, body.source);
            const included = (id: string): boolean => !this.excluded.has(id) && (members?.has(id) ?? true);
            const ids = scoped.filter(t => included(t.id));
            const cursor = body.cursor;
            if (cursor !== undefined && (typeof cursor !== "string" || !cursor.startsWith(scope + ":"))) return problem(400, "invalid_cursor", "Invalid cursor");
            const offset = typeof cursor === "string" ? Number(cursor.slice(scope.length + 1)) : 0;
            // The immutable fixture order stands in for the server's fenced keyset.
            // A removed row before the anchor cannot shift a later page backwards.
            const remaining = scoped.slice(offset).filter(t => included(t.id));
            const selected = remaining.slice(0, limit);
            const last = selected[selected.length - 1];
            const next = last === undefined ? offset : scoped.indexOf(last) + 1;
            const cards = selected.map(t => this.withMembership(super.route("GET", `/catalog/items/${encodeURIComponent(t.id)}`, profile)?.body, profile));
            return { status: 200, body: { window_cursor: scope, items: cards, total: ids.length, total_exact: true, page: remaining.length > limit ? { has_more: true, next_cursor: `${scope}:${next}` } : { has_more: false } } };
        }
        const reply = super.route(method, path, profile, body);
        if (method === "GET" && path.startsWith("/catalog/items/") && reply?.status === 200) return { ...reply, body: this.withMembership(reply.body, profile) };
        return reply;
    }
    /** This catalog keeps list membership itself; cards and items report it in `user_state`, as the server does. */
    private withMembership(value: unknown, profile: string | undefined): unknown {
        if (typeof value !== "object" || value === null || !("content_id" in value) || !("user_state" in value)) return value;
        const id = String(value.content_id);
        return { ...value, user_state: { ...(value.user_state as Record<string, unknown>), is_favorite: this.members(profile, "favorites").has(id), in_watchlist: this.members(profile, "watchlist").has(id) } };
    }
    private members(profile: string | undefined, source: string): Set<string> {
        const key = JSON.stringify([profile, source]);
        let members = this.membershipState.get(key);
        if (members === undefined) {
            members = new Set(this.titles.keys());
            this.membershipState.set(key, members);
        }
        return members;
    }
}
