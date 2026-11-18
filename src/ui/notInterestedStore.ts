// One per-title record of Not interested for a browse session, used by the card menu and by the Details page: the write
// still out (one at a time per title), the state the last answered write left, and how a later read is reconciled with it.

export class NotInterestedStore {
    private serial = 0;
    private readonly out = new Map<string, boolean>();
    private readonly confirmed = new Map<string, { readonly state: boolean; readonly serial: number }>();
    private readonly settled: () => void;

    constructor(settled: () => void = () => undefined) { this.settled = settled; }

    /** Taken when a read starts. A write that starts or is answered after it makes the read possibly out of date. */
    stamp(): number { return this.serial; }

    /** The state the write still out for this title will leave, or undefined when none is out. */
    pending(id: string): boolean | undefined { return this.out.get(id); }

    /**
     * What a surface shows for the title: the write out, else the last answered write when the read it shows began before that
     * answer, else the read itself. A read begun after the answer is authoritative and replaces what was remembered.
     */
    state(id: string, read: boolean | undefined, stamp: number): boolean | undefined {
        const out = this.out.get(id);
        if (out !== undefined) return out;
        const known = this.confirmed.get(id);
        return known !== undefined && known.serial > stamp ? known.state : read;
    }

    start(id: string, target: boolean): void {
        this.serial++;
        this.out.set(id, target);
    }

    /** The write was answered and left the title in `state`, or in an unknown state (undefined) when it was cut off. */
    finish(id: string, state: boolean | undefined): void {
        this.serial++;
        this.out.delete(id);
        if (state === undefined) this.confirmed.delete(id);
        else this.confirmed.set(id, { state, serial: this.serial });
        this.settled();
    }
}
