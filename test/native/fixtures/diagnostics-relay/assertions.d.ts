import type { FakeGitHub } from "./fakeGitHub.js";

export function check(condition: boolean, message: string): void;
export function equal(actual: unknown, expected: unknown, message: string): void;
export function includes(text: unknown, fragment: string, message: string): void;
export function excludes(text: unknown, fragment: string, message: string): void;
export const SENSITIVE: readonly string[];
export function assertNoSensitive(destination: FakeGitHub, label: string): void;
