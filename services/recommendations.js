const stopWords = new Set([
  "the", "a", "an", "and", "or", "of", "to", "in",
  "on", "at", "for", "with", "this", "that", "is",
  "are", "be", "your", "our", "you", "we", "will",
  "event", "events", "demo",
]);

function tokenize(event) {
  const text = [
    event.title,
    event.description,
    event.category,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();

  return (text.match(/[\p{L}\p{M}\p{N}]+/gu) || [])
    .filter((word) => word.length > 1 && !stopWords.has(word));
}

function normalize(vector) {
  let squaredLength = 0;

  for (const value of vector.values()) {
    squaredLength += value * value;
  }

  const length = Math.sqrt(squaredLength);

  if (length === 0) return vector;

  return new Map(
    [...vector].map(([word, value]) => [word, value / length])
  );
}

export function rankEvents(candidates, history) {
  const allEvents = new Map();

  for (const event of [...candidates, ...history]) {
    allEvents.set(event._id.toString(), event);
  }

  const tokenMap = new Map();
  const documentFrequency = new Map();

  for (const [id, event] of allEvents) {
    const tokens = tokenize(event);
    tokenMap.set(id, tokens);

    for (const word of new Set(tokens)) {
      documentFrequency.set(
        word,
        (documentFrequency.get(word) || 0) + 1
      );
    }
  }

  const vectors = new Map();
  const documentCount = allEvents.size;

  for (const [id, tokens] of tokenMap) {
    const counts = new Map();

    for (const word of tokens) {
      counts.set(word, (counts.get(word) || 0) + 1);
    }

    const vector = new Map();

    for (const [word, count] of counts) {
      const inverseFrequency =
        Math.log(
          (1 + documentCount) /
          (1 + documentFrequency.get(word))
        ) + 1;

      vector.set(word, (1 + Math.log(count)) * inverseFrequency);
    }

    vectors.set(id, normalize(vector));
  }

  const profile = new Map();

  for (const event of history) {
    const vector = vectors.get(event._id.toString());

    for (const [word, value] of vector || []) {
      profile.set(word, (profile.get(word) || 0) + value);
    }
  }

  const normalizedProfile = normalize(profile);

  return candidates
    .map((event) => {
      const vector = vectors.get(event._id.toString());
      let score = 0;

      for (const [word, value] of vector || []) {
        score += value * (normalizedProfile.get(word) || 0);
      }

      return {
        event,
        score,
        reason:
          score > 0
            ? "Related to events you saved or registered for."
            : "An upcoming event you can explore.",
      };
    })
    .sort(
      (first, second) =>
        second.score - first.score ||
        new Date(first.event.startDate).getTime() -
          new Date(second.event.startDate).getTime() ||
        first.event._id.toString().localeCompare(
          second.event._id.toString()
        )
    );
}