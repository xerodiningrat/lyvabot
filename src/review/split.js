function splitCodeBlocks(content, language = "txt", maxLength = 1900) {
  const lines = content.split("\n");
  const parts = [];
  let current = "";

  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > maxLength) {
      parts.push(`\`\`\`${language}\n${current}\n\`\`\``);
      current = line;
    } else {
      current = next;
    }
  }

  if (current) {
    parts.push(`\`\`\`${language}\n${current}\n\`\`\``);
  }

  return parts;
}

module.exports = {
  splitCodeBlocks,
};
