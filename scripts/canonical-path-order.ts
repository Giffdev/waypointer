export function isWellFormedString(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (!(nextCodeUnit >= 0xdc00 && nextCodeUnit <= 0xdfff)) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

export function compareCanonicalPaths(left: string, right: string): number {
  if (!isWellFormedString(left) || !isWellFormedString(right)) {
    throw new TypeError("Canonical paths must be well-formed Unicode strings");
  }
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}
