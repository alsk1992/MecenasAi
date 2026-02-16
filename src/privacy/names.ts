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

// =============================================================================
// POLISH NAME DECLINATION (GRAMMATICAL CASES)
// =============================================================================

/**
 * Generate common Polish declinated forms of a surname.
 * Polish has 7 grammatical cases — surnames change form:
 * Kowalski → Kowalskiego (genitive), Kowalskiemu (dative), Kowalskim (instrumental/locative)
 * Nowak → Nowaka (genitive), Nowakowi (dative), Nowakiem (instrumental)
 */
function generateSurnameForms(surname: string): string[] {
  const forms: string[] = [surname];

  // -ski/-cki/-dzki endings (adjective-type surnames — most common)
  if (surname.endsWith('ski') || surname.endsWith('cki') || surname.endsWith('dzki')) {
    const stem = surname.slice(0, -1); // Remove 'i'
    forms.push(stem + 'iego');  // genitive/accusative: Kowalskiego
    forms.push(stem + 'iemu');  // dative: Kowalskiemu
    forms.push(surname + 'm');  // instrumental/locative: Kowalskim
  }
  // -ska/-cka/-dzka endings (female adjective-type)
  else if (surname.endsWith('ska') || surname.endsWith('cka') || surname.endsWith('dzka')) {
    const stem = surname.slice(0, -1); // Remove 'a'
    forms.push(stem + 'iej');   // genitive/dative/locative: Kowalskiej
    forms.push(stem + 'ą');     // instrumental: Kowalską
  }
  // Consonant-ending surnames (Nowak, Mazur, Baran, etc.)
  else if (/[bcdfghjklłmnprsśtwzźż]$/i.test(surname)) {
    forms.push(surname + 'a');    // genitive/accusative: Nowaka
    forms.push(surname + 'owi');  // dative: Nowakowi
    forms.push(surname + 'iem'); // instrumental: Nowakiem (simplified)
    forms.push(surname + 'em');  // instrumental alt: Nowaczem
  }

  return forms;
}

/** Generate common declinated forms of first names */
function generateFirstNameForms(name: string): string[] {
  const forms: string[] = [name];

  // Male names ending in consonant (Jan, Piotr, Adam)
  if (/[bcdfghjklłmnprsśtwzźż]$/i.test(name)) {
    forms.push(name + 'a');    // genitive: Jana
    forms.push(name + 'owi');  // dative: Janowi
    forms.push(name + 'em');   // instrumental: Janem
  }
  // Names ending in -ek (Marek, Jacek)
  if (name.endsWith('ek')) {
    const stem = name.slice(0, -2);
    forms.push(stem + 'ka');     // genitive: Marka
    forms.push(stem + 'kowi');   // dative: Markowi
    forms.push(stem + 'kiem');   // instrumental: Markiem
  }
  // Female names ending in -a (Anna, Maria, Katarzyna)
  if (name.endsWith('a')) {
    const stem = name.slice(0, -1);
    forms.push(stem + 'y');      // genitive: Anny
    forms.push(stem + 'ie');     // dative/locative: Annie
    forms.push(stem + 'ę');      // accusative: Annę
    forms.push(stem + 'ą');      // instrumental: Anną
  }

  return forms;
}

// Build expanded sets with declinated forms
const expandedSurnames = new Set<string>();
for (const s of POLISH_SURNAMES) {
  for (const form of generateSurnameForms(s)) {
    expandedSurnames.add(form);
  }
}

const expandedFirstNamesMale = new Set<string>();
for (const n of POLISH_FIRST_NAMES_MALE) {
  for (const form of generateFirstNameForms(n)) {
    expandedFirstNamesMale.add(form);
  }
}

const expandedFirstNamesFemale = new Set<string>();
for (const n of POLISH_FIRST_NAMES_FEMALE) {
  for (const form of generateFirstNameForms(n)) {
    expandedFirstNamesFemale.add(form);
  }
}

// Combined set for quick lookup (includes nominative + all declinated forms)
const ALL_FIRST_NAMES = new Set([...expandedFirstNamesMale, ...expandedFirstNamesFemale]);

// Export expanded surnames for use in matching
export { expandedSurnames as POLISH_SURNAMES_EXPANDED };

/**
 * Check if a two-word (or more) string matches known Polish name patterns.
 * Conservative: requires first word in first names SET and last word in surnames SET.
 * Returns the matched name or null.
 */
export function matchPolishName(text: string): string | null {
  // First pass: 3-word names (FirstName SecondName Surname)
  const threeWordPattern = /(?<=\s|^|[("])([A-ZŁŚŹŻĆŃĘĄÓ][a-złóśćźżęąń]+)\s+([A-ZŁŚŹŻĆŃĘĄÓ][a-złóśćźżęąń]+)\s+([A-ZŁŚŹŻĆŃĘĄÓ][a-złóśćźżęąń]+)(?=\s|$|[.,;:!?)}\]"'-])/g;
  for (const m of text.matchAll(threeWordPattern)) {
    if (ALL_FIRST_NAMES.has(m[1]) && ALL_FIRST_NAMES.has(m[2]) && expandedSurnames.has(m[3])) {
      return `${m[1]} ${m[2]} ${m[3]}`;
    }
    if (ALL_FIRST_NAMES.has(m[1]) && expandedSurnames.has(m[2]) && expandedSurnames.has(m[3])) {
      return `${m[1]} ${m[2]} ${m[3]}`;
    }
  }

  // Second pass: 2-word names (FirstName Surname) — no greedy 3rd word capture
  const twoWordPattern = /(?<=\s|^|[("])([A-ZŁŚŹŻĆŃĘĄÓ][a-złóśćźżęąń]+)\s+([A-ZŁŚŹŻĆŃĘĄÓ][a-złóśćźżęąń]+)(?=\s|$|[.,;:!?)}\]"'-])/g;
  for (const m of text.matchAll(twoWordPattern)) {
    if (ALL_FIRST_NAMES.has(m[1]) && expandedSurnames.has(m[2])) {
      return `${m[1]} ${m[2]}`;
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
  const usedRanges: Array<[number, number]> = [];

  // First pass: 3-word names (FirstName SecondName Surname)
  const threeWordPattern = /(?<=\s|^|[("])([A-ZŁŚŹŻĆŃĘĄÓ][a-złóśćźżęąń]+)\s+([A-ZŁŚŹŻĆŃĘĄÓ][a-złóśćźżęąń]+)\s+([A-ZŁŚŹŻĆŃĘĄÓ][a-złóśćźżęąń]+)(?=\s|$|[.,;:!?)}\]"'-])/g;
  for (const m of text.matchAll(threeWordPattern)) {
    if (
      (ALL_FIRST_NAMES.has(m[1]) && ALL_FIRST_NAMES.has(m[2]) && expandedSurnames.has(m[3])) ||
      (ALL_FIRST_NAMES.has(m[1]) && expandedSurnames.has(m[2]) && expandedSurnames.has(m[3]))
    ) {
      const name = `${m[1]} ${m[2]} ${m[3]}`;
      results.push({ name, index: m.index! });
      usedRanges.push([m.index!, m.index! + m[0].length]);
    }
  }

  // Second pass: 2-word names — skip ranges already covered by 3-word matches
  const twoWordPattern = /(?<=\s|^|[("])([A-ZŁŚŹŻĆŃĘĄÓ][a-złóśćźżęąń]+)\s+([A-ZŁŚŹŻĆŃĘĄÓ][a-złóśćźżęąń]+)(?=\s|$|[.,;:!?)}\]"'-])/g;
  for (const m of text.matchAll(twoWordPattern)) {
    if (ALL_FIRST_NAMES.has(m[1]) && expandedSurnames.has(m[2])) {
      const idx = m.index!;
      const end = idx + m[0].length;
      // Skip if overlaps with an already-found 3-word name
      if (usedRanges.some(([s, e]) => idx < e && end > s)) continue;
      results.push({ name: `${m[1]} ${m[2]}`, index: idx });
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
