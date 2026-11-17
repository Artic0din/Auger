// Shared with silo-apple ProfileAvatarPresets and silo-server web profile-avatars (AGPL).
/** Each style's id, and the catalog key for its name (silo-apple `ProfileAvatarStyle.title`). */
export const PROFILE_STYLES = [["identicon", "profiles.avatarStyle.identicon"], ["initials", "profiles.avatarStyle.initials"], ["bottts-neutral", "profiles.avatarStyle.bottts"], ["fun-emoji", "profiles.avatarStyle.funEmoji"], ["pixel-art-neutral", "profiles.avatarStyle.pixelArt"]] as const;
const ADJECTIVES = ["cosmic", "jelly", "starlight", "mango", "bubble", "neon", "marble", "comet", "snappy", "pepper", "glimmer", "ripple", "pocket", "candy", "ember", "mochi", "sprout", "twinkle", "whiz", "plasma", "mint", "velvet", "crunchy", "sunbeam", "toffee", "splash", "boomer", "lunar", "fizzy", "biscuit", "rocket", "cobalt"];
const NOUNS = ["otter", "rocket", "fox", "cookie", "gecko", "bunny", "penguin", "puffin", "tiger", "panda", "saturn", "wizard", "skater", "nebula", "robot", "pirate", "meteor", "sprite", "pebble", "nova", "dragon", "donut", "parrot", "panther", "goblin", "muffin", "laser", "pickle", "falcon", "sunset", "toaster", "bandit"];

export function profilePresets(style: string, batch: number): string[] {
    return Array.from({ length: 18 }, (_, index) => `preset:dicebear:${style}:${ADJECTIVES[(batch * 7 + index * 3 + style.length) % ADJECTIVES.length]}-${NOUNS[(batch * 11 + index * 5 + style.length * 2) % NOUNS.length]}`);
}
