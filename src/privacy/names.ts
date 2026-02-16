/**
 * Polish Name Dictionary — common first and last names for PII detection.
 * Used to detect freestanding Polish names (not just after keywords).
 * Conservative: only flags multi-word combinations where BOTH parts match.
 */

// Top ~100 most common Polish male first names
export const POLISH_FIRST_NAMES_MALE = new Set([
  'Adam', 'Adrian', 'Aleksander', 'Andrzej', 'Antoni', 'Arkadiusz', 'Artur',
  'Bartłomiej', 'Bartosz', 'Bogdan', 'Bogusław', 'Cezary', 'Damian', 'Daniel',
  'Dariusz', 'Dawid', 'Dominik', 'Edward', 'Ernest', 'Filip', 'Franciszek',
  'Gabriel', 'Grzegorz', 'Henryk', 'Hubert', 'Igor', 'Ireneusz', 'Jacek',
  'Jakub', 'Jan', 'Janusz', 'Jarosław', 'Jerzy', 'Józef', 'Kamil', 'Karol',
  'Kazimierz', 'Konrad', 'Krystian', 'Krzysztof', 'Lech', 'Leszek', 'Łukasz',
  'Maciej', 'Marcin', 'Marek', 'Mariusz', 'Mateusz', 'Michał', 'Mieczysław',
  'Mirosław', 'Norbert', 'Olaf', 'Oskar', 'Paweł', 'Patryk', 'Piotr',
  'Przemysław', 'Radosław', 'Rafał', 'Robert', 'Roman', 'Ryszard', 'Sebastian',
  'Sławomir', 'Stanisław', 'Stefan', 'Szymon', 'Tadeusz', 'Tomasz', 'Waldemar',
  'Wiesław', 'Wiktor', 'Witold', 'Władysław', 'Wojciech', 'Zbigniew', 'Zenon',
  'Zygmunt',
]);

// Top ~100 most common Polish female first names
export const POLISH_FIRST_NAMES_FEMALE = new Set([
  'Agata', 'Agnieszka', 'Aleksandra', 'Alicja', 'Amelia', 'Anna', 'Barbara',
  'Beata', 'Bożena', 'Celina', 'Dagmara', 'Danuta', 'Dorota', 'Edyta',
  'Elżbieta', 'Emilia', 'Ewa', 'Gabriela', 'Grażyna', 'Halina', 'Hanna',
  'Helena', 'Irena', 'Iwona', 'Izabela', 'Jadwiga', 'Janina', 'Joanna',
  'Jolanta', 'Julia', 'Justyna', 'Kamila', 'Karolina', 'Katarzyna', 'Kinga',
  'Klaudia', 'Krystyna', 'Laura', 'Lena', 'Lidia', 'Liliana', 'Lucyna',
  'Magdalena', 'Maja', 'Małgorzata', 'Maria', 'Marlena', 'Marta', 'Martyna',
  'Milena', 'Monika', 'Nadia', 'Natalia', 'Nicole', 'Nina', 'Oliwia',
  'Patrycja', 'Paulina', 'Renata', 'Roma', 'Sandra', 'Sara', 'Stanisława',
  'Sylwia', 'Teresa', 'Urszula', 'Wanda', 'Weronika', 'Wiktoria', 'Zofia',
  'Zuzanna',
]);

// Top ~100 most common Polish surnames
export const POLISH_SURNAMES = new Set([
  'Nowak', 'Kowalski', 'Wiśniewski', 'Wójcik', 'Kowalczyk', 'Kamiński',
  'Lewandowski', 'Zieliński', 'Szymański', 'Woźniak', 'Dąbrowski', 'Kozłowski',
  'Jankowski', 'Mazur', 'Kwiatkowski', 'Krawczyk', 'Piotrowski', 'Grabowski',
  'Nowakowski', 'Pawłowski', 'Michalski', 'Nowicki', 'Adamczyk', 'Dudek',
  'Zając', 'Wieczorek', 'Jabłoński', 'Król', 'Majewski', 'Olszewski',
  'Jaworski', 'Wróbel', 'Malinowski', 'Pawlak', 'Witkowski', 'Walczak',
  'Stępień', 'Górski', 'Rutkowski', 'Michalak', 'Sikora', 'Ostrowski',
  'Baran', 'Duda', 'Szewczyk', 'Tomaszewski', 'Pietrzak', 'Marciniak',
  'Wróblewski', 'Zalewski', 'Jakubowski', 'Jasiński', 'Zawadzki', 'Sadowski',
  'Bąk', 'Chmielewski', 'Włodarczyk', 'Borkowski', 'Czarnecki', 'Sawicki',
  'Sokołowski', 'Urbański', 'Kubiak', 'Maciejewski', 'Szczepański', 'Kucharski',
  'Wilk', 'Kalinowski', 'Lis', 'Mazurek', 'Wysocki', 'Adamski', 'Kaźmierczak',
  'Wasilewski', 'Sobczak', 'Czerwiński', 'Andrzejewski', 'Cieślak', 'Głowacki',
  'Zakrzewski', 'Kołodziej', 'Sikorski', 'Krajewski', 'Gajewski', 'Szymczak',
  'Kozak', 'Pawlik', 'Sobczyk', 'Sikora', 'Mróz', 'Laskowski', 'Ziółkowski',
  // Female surname variants (-ska/-cka)
  'Nowakowa', 'Kowalska', 'Wiśniewska', 'Wójcikowa', 'Kowalczykowa', 'Kamińska',
  'Lewandowska', 'Zielińska', 'Szymańska', 'Woźniakowa', 'Dąbrowska', 'Kozłowska',
  'Jankowska', 'Mazurowa', 'Kwiatkowska', 'Krawczykowa', 'Piotrowska', 'Grabowska',
  'Nowakowska', 'Pawłowska', 'Michalska', 'Nowicka', 'Adamczykowa',
]);

// Combined set for quick lookup
const ALL_FIRST_NAMES = new Set([...POLISH_FIRST_NAMES_MALE, ...POLISH_FIRST_NAMES_FEMALE]);

/**
 * Check if a two-word (or more) string matches known Polish name patterns.
 * Conservative: requires first word in first names SET and last word in surnames SET.
 * Returns the matched name or null.
 */
export function matchPolishName(text: string): string | null {
  // Match sequences of 2-3 capitalized Polish words
  const namePattern = /\b([A-ZŁŚŹŻĆŃĘĄÓ][a-złóśćźżęąń]+)\s+([A-ZŁŚŹŻĆŃĘĄÓ][a-złóśćźżęąń]+)(?:\s+([A-ZŁŚŹŻĆŃĘĄÓ][a-złóśćźżęąń]+))?\b/g;

  for (const m of text.matchAll(namePattern)) {
    const first = m[1];
    const second = m[2];
    const third = m[3];

    // Pattern: FirstName Surname
    if (ALL_FIRST_NAMES.has(first) && POLISH_SURNAMES.has(second)) {
      return third ? `${first} ${second} ${third}` : `${first} ${second}`;
    }

    // Pattern: FirstName SecondName Surname (e.g. "Jan Maria Kowalski")
    if (third && ALL_FIRST_NAMES.has(first) && ALL_FIRST_NAMES.has(second) && POLISH_SURNAMES.has(third)) {
      return `${first} ${second} ${third}`;
    }
  }

  return null;
}

/**
 * Find ALL Polish name matches in text.
 * Returns array of { name, index } for each match.
 */
export function findPolishNames(text: string): Array<{ name: string; index: number }> {
  const results: Array<{ name: string; index: number }> = [];
  const namePattern = /\b([A-ZŁŚŹŻĆŃĘĄÓ][a-złóśćźżęąń]+)\s+([A-ZŁŚŹŻĆŃĘĄÓ][a-złóśćźżęąń]+)(?:\s+([A-ZŁŚŹŻĆŃĘĄÓ][a-złóśćźżęąń]+))?\b/g;

  for (const m of text.matchAll(namePattern)) {
    const first = m[1];
    const second = m[2];
    const third = m[3];

    if (ALL_FIRST_NAMES.has(first) && POLISH_SURNAMES.has(second)) {
      const name = third ? `${first} ${second} ${third}` : `${first} ${second}`;
      results.push({ name, index: m.index! });
    } else if (third && ALL_FIRST_NAMES.has(first) && ALL_FIRST_NAMES.has(second) && POLISH_SURNAMES.has(third)) {
      results.push({ name: `${first} ${second} ${third}`, index: m.index! });
    }
  }

  return results;
}

/**
 * Quick check: does text contain any known Polish name?
 */
export function containsPolishName(text: string): boolean {
  return matchPolishName(text) !== null;
}
