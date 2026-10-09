class ReadingList:
    def __init__(self):
        self._titles = []

    def add(self, title):
        normalized = title.strip()
        if not normalized or any(existing.casefold() == normalized.casefold() for existing in self._titles):
            return False
        self._titles.append(normalized)
        return True

    def remove(self, title):
        # Intentional regression: this lookup should ignore case.
        normalized = title.strip()
        if normalized not in self._titles:
            return False
        self._titles.remove(normalized)
        return True

    def titles(self):
        return list(self._titles)
