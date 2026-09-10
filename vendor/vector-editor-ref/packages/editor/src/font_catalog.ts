/**
 * The Google Fonts catalog, as served by the Fontsource CDN.
 *
 * GENERATED FILE — do not edit by hand. Run `scripts/gen_font_catalog.ts` to
 * refresh it. Generated 2026-09-04 from 1980 families.
 *
 * Stored as one packed line per family rather than an array of objects: at this
 * size the object literal costs a few hundred KB of source and a parse on every
 * load, while the packed form is a single string the module splits once, the
 * first time anything asks for a font.
 *
 * Line format: `family|category|weights|styles|subset`
 *   category  index into FONT_CATEGORIES
 *   weights   one digit per hundred, ascending — "4567" is 400/500/600/700
 *   styles    "n", "i", or "ni"
 *   subset    the subset to fetch faces from; empty means latin
 */

/** Category names, in the order the packed `category` index refers to. */
export const FONT_CATEGORIES = [
    'sans-serif',
    'serif',
    'display',
    'handwriting',
    'monospace',
    'icons',
] as const;

export type FontCategory = (typeof FONT_CATEGORIES)[number];

/** One family: what it is called, and which faces actually exist for it. */
export interface FontMeta {
    /** Display name, e.g. "Instrument Sans". */
    family: string;
    /** Fontsource CDN id, e.g. "instrument-sans". */
    id: string;
    category: FontCategory;
    /** Published weights, ascending. Never empty. */
    weights: number[];
    hasNormal: boolean;
    hasItalic: boolean;
    /** Subset the faces are fetched from — "latin" for all but a handful. */
    subset: string;
}

const PACKED = `\
42dot Sans|0|345678|n|
ABeeZee|0|4|ni|
Abel|0|4|n|
Abhaya Libre|1|45678|n|
Aboreto|2|4|n|
Abril Fatface|2|4|n|
Abyssinica SIL|1|4|n|
Aclonica|0|4|n|
Acme|0|4|n|
Actor|0|4|n|
Adamina|1|4|n|
ADLaM Display|2|4|n|
Advent Pro|0|123456789|ni|
Afacad|0|4567|ni|
Afacad Flux|0|123456789|n|
Agbalumo|2|4|n|
Agdasima|0|47|n|
Agu Display|2|4|n|
Aguafina Script|3|4|n|
Akatab|0|456789|n|
Akaya Kanadaka|2|4|n|
Akaya Telivigala|2|4|n|
Akronim|2|4|n|
Akshar|0|34567|n|
Akt|0|123456789|n|
Aladin|2|4|n|
Alan Sans|0|3456789|n|
Alata|0|4|n|
Alatsi|0|4|n|
Albert Sans|0|123456789|ni|
Aldrich|0|4|n|
Alef|0|47|n|
Alegreya|1|456789|ni|
Alegreya Sans|0|1345789|ni|
Alegreya Sans SC|0|1345789|ni|
Alegreya SC|1|45789|ni|
Aleo|1|123456789|ni|
Alex Brush|3|4|n|
Alexandria|0|123456789|n|
Alfa Slab One|2|4|n|
Alice|1|4|n|
Alien Block|2|4|n|
Alike|1|4|n|
Alike Angular|1|4|n|
Alkalami|1|4|n|
Alkatra|2|4567|n|
Allan|2|47|n|
Allerta|0|4|n|
Allerta Stencil|0|4|n|
Allison|3|4|n|
Allkin|2|4|n|
Allura|3|4|n|
Almarai|0|3478|n|
Almendra|1|47|ni|
Almendra Display|2|4|n|
Almendra SC|1|4|n|
Alumni Sans|0|123456789|ni|
Alumni Sans Collegiate One|0|4|ni|
Alumni Sans Inline One|2|4|ni|
Alumni Sans Pinstripe|0|4|ni|
Alumni Sans SC|0|123456789|ni|
Alyamama|1|3456789|n|
Amarante|2|4|n|
Amaranth|0|47|ni|
Amarna|0|1234567|ni|
Amatic SC|3|47|n|
Amethysta|1|4|n|
Amiko|0|467|n|
Amiri|1|47|ni|
Amiri Quran|1|4|n|
Amita|3|47|n|
Anaheim|0|45678|n|
Ancizar Sans|0|123456789|ni|
Ancizar Serif|1|3456789|ni|
Andada Pro|1|45678|ni|
Andika|0|47|ni|
Anek Bangla|0|12345678|n|
Anek Devanagari|0|12345678|n|
Anek Gujarati|0|12345678|n|
Anek Gurmukhi|0|12345678|n|
Anek Kannada|0|12345678|n|
Anek Latin|0|12345678|n|
Anek Malayalam|0|12345678|n|
Anek Odia|0|12345678|n|
Anek Tamil|0|12345678|n|
Anek Telugu|0|12345678|n|
Angkor|2|4|n|
Annapurna SIL|1|47|n|
Annie Use Your Telescope|3|4|n|
Anonymous Pro|4|47|ni|
Anta|0|4|n|
Antic|0|4|n|
Antic Didone|1|4|n|
Antic Slab|1|4|n|
Anton|0|4|n|
Anton SC|0|4|n|
Antonio|0|1234567|n|
Anuphan|0|1234567|n|
Anybody|2|123456789|ni|
Aoboshi One|1|4|n|
AR One Sans|0|4567|n|
Arapey|1|4|ni|
Arbutus|1|4|n|
Arbutus Slab|1|4|n|
Architects Daughter|3|4|n|
Archivo|0|123456789|ni|
Archivo Black|0|4|n|
Archivo Narrow|0|4567|ni|
Are You Serious|3|4|n|
Aref Ruqaa|1|47|n|
Aref Ruqaa Ink|1|47|n|
Arima|2|1234567|n|
Arima Madurai|2|12345789|n|
Arimo|0|4567|ni|
Arizonia|3|4|n|
Armata|0|4|n|
Arsenal|0|47|ni|
Arsenal SC|0|47|ni|
Artifika|1|4|n|
Arvo|1|47|ni|
Arya|0|47|n|
Asap|0|123456789|ni|
Asap Condensed|0|23456789|ni|
Asap Sharp|0|123456789|ni|
Asar|1|4|n|
Asimovian|0|4|n|
Asset|2|4|n|
Assistant|0|2345678|n|
Asta Sans|0|345678|n|
Astloch|2|47|n|
Asul|1|47|n|
Athiti|0|234567|n|
Atkinson Hyperlegible|0|47|ni|
Atkinson Hyperlegible Mono|0|2345678|ni|
Atkinson Hyperlegible Next|0|2345678|ni|
Atma|2|34567|n|
Atomic Age|2|4|n|
Aubrey|2|4|n|
Audiowide|2|4|n|
Autour One|2|4|n|
Average|1|4|n|
Average Sans|0|4|n|
Averia Gruesa Libre|2|4|n|
Averia Libre|2|347|ni|
Averia Sans Libre|2|347|ni|
Averia Serif Libre|2|347|ni|
Azeret Mono|4|123456789|ni|
B612|0|47|ni|
B612 Mono|4|47|ni|
Babylonica|3|4|n|
Bacasime Antique|1|4|n|
Bad Script|3|4|n|
Badeen Display|2|4|n|
Bagel Fat One|2|4|n|
Bahiana|2|4|n|
Bahianita|2|4|n|
Bai Jamjuree|0|234567|ni|
Bakbak One|2|4|n|
Ballet|3|4|n|
Baloo 2|2|45678|n|
Baloo Bhai 2|2|45678|n|
Baloo Bhaijaan 2|2|45678|n|
Baloo Bhaina 2|2|45678|n|
Baloo Chettan 2|2|45678|n|
Baloo Da 2|2|45678|n|
Baloo Paaji 2|2|45678|n|
Baloo Tamma 2|2|45678|n|
Baloo Tammudu 2|2|45678|n|
Baloo Thambi 2|2|45678|n|
Balsamiq Sans|2|47|ni|
Balthazar|1|4|n|
Bangers|2|4|n|
Barlow|0|123456789|ni|
Barlow Condensed|0|123456789|ni|
Barlow Semi Condensed|0|123456789|ni|
Barriecito|2|4|n|
Barrio|2|4|n|
Basic|0|4|n|
Baskervville|1|4567|ni|
Baskervville SC|1|4567|n|
Battambang|2|13479|n|
Baumans|2|4|n|
Bayon|0|4|n|
BBH Bartle|0|4|n|
BBH Bogle|0|4|n|
BBH Hegarty|0|4|n|
BBH Sans Bartle|0|4|n|
BBH Sans Bogle|0|4|n|
BBH Sans Hegarty|0|4|n|
Be Vietnam Pro|0|123456789|ni|
Beau Rivage|3|4|n|
Bebas Neue|0|4|n|
Beiruti|0|23456789|n|
Belanosima|0|467|n|
Belgrano|1|4|n|
Bellefair|1|4|n|
Belleza|0|4|n|
Bellota|2|347|ni|
Bellota Text|2|347|ni|
BenchNine|0|347|n|
Benne|1|4|n|
Bentham|1|4|n|
Berkshire Swash|3|4|n|
Besley|1|456789|ni|
Betania Patmos|3|4|n|
Betania Patmos GDL|3|4|n|
Betania Patmos In|3|4|n|
Betania Patmos In GDL|3|4|n|
Beth Ellen|3|4|n|
Bevan|1|4|ni|
BhuTuka Expanded One|1|4|n|
Big Shoulders|2|123456789|n|
Big Shoulders Display|2|123456789|n|
Big Shoulders Inline|2|123456789|n|
Big Shoulders Inline Display|2|123456789|n|
Big Shoulders Inline Text|2|123456789|n|
Big Shoulders Stencil|2|123456789|n|
Big Shoulders Stencil Display|2|123456789|n|
Big Shoulders Stencil Text|2|123456789|n|
Big Shoulders Text|2|123456789|n|
Bigelow Rules|2|4|n|
Bigshot One|2|4|n|
Bilbo|3|4|n|
Bilbo Swash Caps|3|4|n|
BioRhyme|1|2345678|n|
BioRhyme Expanded|1|23478|n|
Birthstone|3|4|n|
Birthstone Bounce|3|45|n|
Biryani|0|2346789|n|
Bitcount|2|123456789|n|
Bitcount Grid Double|2|123456789|n|
Bitcount Grid Double Ink|2|123456789|n|
Bitcount Grid Single|2|123456789|n|
Bitcount Grid Single Ink|2|123456789|n|
Bitcount Ink|2|123456789|n|
Bitcount Prop Double|2|123456789|n|
Bitcount Prop Double Ink|2|123456789|n|
Bitcount Prop Single|2|123456789|n|
Bitcount Prop Single Ink|2|123456789|n|
Bitcount Single|2|123456789|n|
Bitcount Single Ink|2|123456789|n|
Bitter|1|123456789|ni|
BIZ UDGothic|0|47|n|
BIZ UDMincho|1|47|n|
BIZ UDPGothic|0|47|n|
BIZ UDPMincho|1|47|n|
BJ Cree|1|4567|n|
BJCree|1|4567|n|
Black And White Picture|2|4|n|
Black Han Sans|0|4|n|
Black Ops One|2|4|n|
Blaka|2|4|n|
Blaka Hollow|2|4|n|
Blaka Ink|2|4|n|
Blinker|0|12346789|n|
Bodoni Moda|1|456789|ni|
Bodoni Moda SC|1|456789|ni|
Bokor|2|4|n|
Boldonse|2|4|n|
Bona Nova|1|47|ni|
Bona Nova SC|1|47|ni|
Bonbon|3|4|n|
Bonheur Royale|3|4|n|
Boogaloo|2|4|n|
Borel|3|4|n|
Bowlby One|2|4|n|
Bowlby One SC|2|4|n|
Bpmf Huninn|0|4|n|
Bpmf Iansui|3|4|n|
Bpmf Zihi Kai Std|0|4|n|
Braah One|0|4|n|
Brawler|1|47|n|
Bree Serif|1|4|n|
Bricolage Grotesque|0|2345678|n|
Briem Hand|3|123456789|n|
Bruno Ace|2|4|n|
Bruno Ace SC|2|4|n|
Brygada 1918|1|4567|ni|
Bubblegum Sans|2|4|n|
Bubbler One|0|4|n|
Buda|2|3|n|
Buenard|1|4567|n|
Bungee|2|4|n|
Bungee Hairline|2|4|n|
Bungee Inline|2|4|n|
Bungee Outline|2|4|n|
Bungee Shade|2|4|n|
Bungee Spice|2|4|n|
Bungee Tint|2|4|n|
Butcherman|2|4|n|
Butterfly Kids|3|4|n|
Bytesized|0|4|n|
Caacupe One|2|4|n|
Cabin|0|4567|ni|
Cabin Condensed|0|4567|n|
Cabin Sketch|2|47|n|
Cactus Classical Serif|1|4|n|
Caesar Dressing|2|4|n|
Cagliostro|0|4|n|
Cairo|0|23456789|n|
Cairo Play|0|23456789|n|
Cal Sans|0|4|n|
Caladea|1|47|ni|
Calistoga|2|4|n|
Calligraffitti|3|4|n|
Cambay|0|47|ni|
Cambo|1|4|n|
Candal|0|4|n|
Cantarell|0|47|ni|
Cantata One|1|4|n|
Cantora One|0|4|n|
Caprasimo|2|4|n|
Capriola|0|4|n|
Caramel|3|4|n|
Carattere|3|4|n|
Cardo|1|47|ni|
Carlito|0|47|ni|
Carme|0|4|n|
Carrois Gothic|0|4|n|
Carrois Gothic SC|0|4|n|
Carter One|2|4|n|
Cascadia Code|0|234567|ni|
Cascadia Mono|0|234567|ni|
Castoro|1|4|ni|
Castoro Titling|2|4|n|
Catamaran|0|123456789|n|
Caudex|1|47|ni|
Cause|3|123456789|n|
Caveat|3|4567|n|
Caveat Brush|3|4|n|
Cedarville Cursive|3|4|n|
Ceviche One|2|4|n|
Chakra Petch|0|34567|ni|
Changa|0|2345678|n|
Changa One|2|4|ni|
Chango|2|4|n|
Charis SIL|1|47|ni|
Charm|3|47|n|
Charmonman|3|47|n|
Chathura|0|13478|n|
Chau Philomene One|0|4|ni|
Chela One|2|4|n|
Chelsea Market|2|4|n|
Chenla|2|4|n|khmer
Cherish|3|4|n|
Cherry Bomb One|2|4|n|
Cherry Cream Soda|2|4|n|
Cherry Swash|2|47|n|
Chewy|2|4|n|
Chicle|2|4|n|
Chilanka|3|4|n|
Chiron GoRound TC|0|23456789|n|
Chiron Hei HK|0|23456789|ni|
Chiron Sung HK|1|23456789|ni|
Chivo|0|123456789|ni|
Chivo Mono|4|123456789|ni|
Chocolate Classical Sans|0|4|n|
Chokokutai|2|4|n|
Chonburi|2|4|n|
Cinzel|1|456789|n|
Cinzel Decorative|2|479|n|
Clicker Script|3|4|n|
Climate Crisis|2|4|n|
Coda|2|48|n|
Coda Caption|0|8|n|
Codystar|2|34|n|
Coiny|2|4|n|
Combo|2|4|n|
Comfortaa|2|34567|n|
Comforter|3|4|n|
Comforter Brush|3|4|n|
Comic Neue|3|347|ni|
Comic Relief|2|47|n|
Coming Soon|3|4|n|
Comme|0|123456789|n|
Commissioner|0|123456789|n|
Concert One|2|4|n|
Condiment|3|4|n|
Content|2|47|n|khmer
Contrail One|2|4|n|
Convergence|0|4|n|
Cookie|3|4|n|
Copse|1|4|n|
Coral Pixels|2|4|n|
Corben|2|47|n|
Corinthia|3|47|n|
Cormorant|1|34567|ni|
Cormorant Garamond|1|34567|ni|
Cormorant Infant|1|34567|ni|
Cormorant SC|1|34567|n|
Cormorant Unicase|1|34567|n|
Cormorant Upright|1|34567|n|
Cossette Texte|0|47|n|
Cossette Titre|0|47|n|
Courgette|3|4|n|
Courier Prime|4|47|ni|
Cousine|4|47|ni|
Coustard|1|49|n|
Covered By Your Grace|3|4|n|
Crafty Girls|3|4|n|
Creepster|2|4|n|
Crete Round|1|4|ni|
Crimson Pro|1|23456789|ni|
Crimson Text|1|467|ni|
Croissant One|2|4|n|
Crushed|2|4|n|
Cuprum|0|4567|ni|
Cute Font|2|4|n|
Cutive|1|4|n|
Cutive Mono|4|4|n|
Dai Banna SIL|1|34567|ni|
Damion|3|4|n|
Dancing Script|3|4567|n|
Danfo|1|4|n|
Dangrek|2|4|n|
Darker Grotesque|0|3456789|n|
Darumadrop One|2|4|n|
Datatype|4|123456789|n|
David Libre|1|457|n|
Dawning of a New Day|3|4|n|
Days One|0|4|n|
Dekko|3|4|n|
Dela Gothic One|2|4|n|
Delicious Handrawn|3|4|n|
Delius|3|4|n|
Delius Swash Caps|3|4|n|
Delius Unicase|3|47|n|
Della Respira|1|4|n|
Denk One|0|4|n|
Devonshire|3|4|n|
Dhurjati|0|4|n|
Didact Gothic|0|4|n|
Diphylleia|1|4|n|
Diplomata|2|4|n|
Diplomata SC|2|4|n|
DM Mono|4|345|ni|
DM Sans|0|123456789|ni|
DM Serif Display|1|4|ni|
DM Serif Text|1|4|ni|
Do Hyeon|0|4|n|
Dokdo|2|4|n|
Domine|1|4567|n|
Donegal One|1|4|n|
Dongle|0|347|n|
Doppio One|0|4|n|
Dorsa|0|4|n|
Dosis|0|2345678|n|
DotGothic16|0|4|n|
Doto|0|123456789|n|
Dr Sugiyama|3|4|n|
Duru Sans|0|4|n|
Dynalight|2|4|n|
DynaPuff|2|4567|n|
Eagle Lake|3|4|n|
East Sea Dokdo|3|4|n|
Eater|2|4|n|
EB Garamond|1|45678|ni|
Economica|0|47|ni|
Eczar|1|45678|n|
Edu AU VIC WA NT Arrows|3|4567|n|
Edu AU VIC WA NT Dots|3|4567|n|
Edu AU VIC WA NT Guides|3|4567|n|
Edu AU VIC WA NT Hand|3|4567|n|
Edu AU VIC WA NT Pre|3|4567|n|
Edu NSW ACT Cursive|3|4567|n|
Edu NSW ACT Foundation|3|4567|n|
Edu NSW ACT Hand Pre|3|4567|n|
Edu QLD Beginner|3|4567|n|
Edu QLD Hand|3|4567|n|
Edu SA Beginner|3|4567|n|
Edu SA Hand|3|4567|n|
Edu TAS Beginner|3|4567|n|
Edu VIC WA NT Beginner|3|4567|n|
Edu VIC WA NT Hand|3|4567|n|
Edu VIC WA NT Hand Pre|3|4567|n|
El Messiri|0|4567|n|
Electrolize|0|4|n|
Elms Sans|0|123456789|ni|
Elsie|2|49|n|
Elsie Swash Caps|2|49|n|
Emblema One|2|4|n|
Emilys Candy|2|4|n|
Encode Sans|0|123456789|n|
Encode Sans Condensed|0|123456789|n|
Encode Sans Expanded|0|123456789|n|
Encode Sans SC|0|123456789|n|
Encode Sans Semi Condensed|0|123456789|n|
Encode Sans Semi Expanded|0|123456789|n|
Engagement|3|4|n|
Englebert|0|4|n|
Enriqueta|1|4567|n|
Ephesis|3|4|n|
Epilogue|0|123456789|ni|
Epunda Sans|0|3456789|ni|
Epunda Slab|1|3456789|ni|
Erica One|2|4|n|
Esteban|1|4|n|
Estedad|0|123456789|n|
Estonia|3|4|n|
Euphoria Script|3|4|n|
Ewert|2|4|n|
Exile|2|4|n|
Exo|0|123456789|ni|
Exo 2|0|123456789|ni|
Expletus Sans|2|4567|ni|
Explora|3|4|n|
Faculty Glyphic|0|4|n|
Fahkwang|0|234567|ni|
Familjen Grotesk|0|4567|ni|
Fanwood Text|1|4|ni|
Farro|0|3457|n|
Farsan|2|4|n|
Fascinate|2|4|n|
Fascinate Inline|2|4|n|
Faster One|2|4|n|
Fasthand|2|4|n|
Fauna One|1|4|n|
Faustina|1|345678|ni|
Federant|2|4|n|
Federo|0|4|n|
Felipa|3|4|n|
Fenix|1|4|n|
Festive|3|4|n|
Figtree|0|3456789|ni|
Finger Paint|2|4|n|
Finlandica|0|4567|ni|
Finlandica Headline|0|123456789|ni|
Finlandica Text|0|123456789|ni|
Fira Code|4|34567|n|
Fira Mono|4|457|n|
Fira Sans|0|123456789|ni|
Fira Sans Condensed|0|123456789|ni|
Fira Sans Extra Condensed|0|123456789|ni|
Fjalla One|0|4|n|
Fjord One|1|4|n|
Flamenco|2|34|n|
Flavors|2|4|n|
Fleur De Leah|3|4|n|
Flow Block|2|4|n|
Flow Circular|2|4|n|
Flow Rounded|2|4|n|
Foldit|2|123456789|n|
Fondamento|3|4|ni|
Fontdiner Swanky|2|4|n|
Forum|2|4|n|
Fragment Mono|4|4|ni|
Francois One|0|4|n|
Frank Ruhl Libre|1|3456789|n|
Fraunces|1|123456789|ni|
Freckle Face|2|4|n|
Fredericka the Great|2|4|n|
Fredoka|0|34567|n|
Fredoka One|2|4|n|
Freehand|2|4|n|
Freeman|2|4|n|
Fresca|0|4|n|
Frijole|2|4|n|
Fruktur|2|4|ni|
Fugaz One|2|4|n|
Fuggles|3|4|n|
Funnel Display|2|345678|n|
Funnel Sans|0|345678|ni|
Fustat|0|2345678|n|
Fuzzy Bubbles|3|47|n|
Ga Maamli|2|4|n|
Gabarito|2|456789|n|
Gabriela|1|4|n|
Gaegu|3|347|n|
Gafata|0|4|n|
Gajraj One|2|4|n|
Galada|2|4|n|
Galdeano|0|4|n|
Galindo|2|4|n|
Gamja Flower|3|4|n|
Gantari|0|123456789|ni|
Gasoek One|0|4|n|
Gayathri|0|147|n|
Geist|0|123456789|ni|
Geist Mono|4|123456789|ni|
Geist Pixel|2|4|n|
Gelasio|1|4567|ni|
Gemunu Libre|0|2345678|n|
Genos|0|123456789|ni|
Gentium Book Basic|1|47|ni|
Gentium Book Plus|1|47|ni|
Gentium Plus|1|47|ni|
Geo|0|4|ni|
Geologica|0|123456789|n|
Geom|0|3456789|ni|
Geomini|0|2345678|n|
Georama|0|123456789|ni|
Geostar|2|4|n|
Geostar Fill|2|4|n|
Germania One|2|4|n|
GFS Didot|1|4|n|
GFS Neohellenic|0|47|ni|
Gideon Roman|2|4|n|
Gidole|0|4|n|
Gidugu|0|4|n|
Gilda Display|1|4|n|
Girassol|2|4|n|
Give You Glory|3|4|n|
Glass Antiqua|2|4|n|
Glegoo|1|47|n|
Gloock|1|4|n|
Gloria Hallelujah|3|4|n|
Glory|0|12345678|ni|
Gluten|2|123456789|n|
Goblin One|2|4|n|
Gochi Hand|3|4|n|
Goldman|2|47|n|
Golos Text|0|456789|n|
Google Sans|0|4567|ni|
Google Sans Code|4|345678|ni|
Google Sans Flex|0|123456789|n|
Gorditas|2|47|n|
Gothic A1|0|123456789|n|
Gotu|0|4|n|
Goudy Bookletter 1911|1|4|n|
Gowun Batang|1|47|n|
Gowun Dodum|0|4|n|
Graduate|1|4|n|
Grand Hotel|3|4|n|
Grandiflora One|1|4|n|
Grandstander|2|123456789|ni|
Grape Nuts|3|4|n|
Gravitas One|2|4|n|
Great Vibes|3|4|n|
Grechen Fuemen|3|4|n|
Grenze|1|123456789|ni|
Grenze Gotisch|2|123456789|n|
Grey Qo|3|4|n|
Griffy|2|4|n|
Gruppo|0|4|n|
Gudea|0|47|ni|
Gugi|2|4|n|
Gulzar|1|4|n|
Gupter|1|457|n|
Gurajada|0|4|n|
Gveret Levin|3|4|n|
Gwendolyn|3|47|n|
Habibi|1|4|n|
Hachi Maru Pop|3|4|n|
Hahmlet|1|123456789|n|
Halant|1|34567|n|
Hammersmith One|0|4|n|
Hanalei|2|4|n|
Hanalei Fill|2|4|n|
Handjet|2|123456789|n|
Handlee|3|4|n|
Hanken Grotesk|0|123456789|ni|
Hanuman|1|123456789|n|
Happy Monkey|2|4|n|
Harmattan|0|4567|n|
Headland One|1|4|n|
Hedvig Letters Sans|0|4|n|
Hedvig Letters Serif|1|4|n|
Heebo|0|123456789|n|
Henny Penny|2|4|n|
Hepta Slab|1|123456789|n|
Herr Von Muellerhoff|3|4|n|
Hi Melody|3|4|n|
Hibur Mono|4|4|n|
Hina Mincho|1|4|n|
Hind|0|34567|n|
Hind Guntur|0|34567|n|
Hind Madurai|0|34567|n|
Hind Mysuru|0|34567|n|
Hind Siliguri|0|34567|n|
Hind Vadodara|0|34567|n|
Holtwood One SC|1|4|n|
Homemade Apple|3|4|n|
Homenaje|0|4|n|
Honk|2|4|n|
Host Grotesk|0|345678|ni|
Hubballi|0|4|n|
Hubot Sans|0|23456789|ni|
Huninn|0|4|n|
Hurricane|3|4|n|
Iansui|3|4|n|
Ibarra Real Nova|1|4567|ni|
IBM Plex Mono|4|1234567|ni|
IBM Plex Sans|0|1234567|ni|
IBM Plex Sans Arabic|0|1234567|n|
IBM Plex Sans Condensed|0|1234567|ni|
IBM Plex Sans Devanagari|0|1234567|n|
IBM Plex Sans Hebrew|0|1234567|n|
IBM Plex Sans JP|0|1234567|n|
IBM Plex Sans KR|0|1234567|n|
IBM Plex Sans Thai|0|1234567|n|
IBM Plex Sans Thai Looped|0|1234567|n|
IBM Plex Serif|1|1234567|ni|
Iceberg|2|4|n|
Iceland|2|4|n|
Idiqlat|1|234|n|
IM Fell Double Pica|1|4|ni|
IM Fell Double Pica SC|1|4|n|
IM Fell DW Pica|1|4|ni|
IM Fell DW Pica SC|1|4|n|
IM Fell English|1|4|ni|
IM Fell English SC|1|4|n|
IM Fell French Canon|1|4|ni|
IM Fell French Canon SC|1|4|n|
IM Fell Great Primer|1|4|ni|
IM Fell Great Primer SC|1|4|n|
Imbue|1|123456789|n|
Imperial Script|3|4|n|
Imprima|0|4|n|
Inclusive Sans|0|34567|ni|
Inconsolata|4|23456789|n|
Inder|0|4|n|
Indie Flower|3|4|n|
Ingrid Darling|3|4|n|
Inika|1|47|n|
Inknut Antiqua|1|3456789|n|
Inria Sans|0|347|ni|
Inria Serif|1|347|ni|
Inspiration|3|4|n|
Instrument Sans|0|4567|ni|
Instrument Serif|1|4|ni|
Intel One Mono|4|34567|ni|
Inter|0|123456789|ni|
Inter Tight|0|123456789|ni|
Iosevka Charon|4|3457|ni|
Iosevka Charon Mono|4|3457|ni|
Irish Grover|2|4|n|
Island Moments|3|4|n|
Istok Web|0|47|ni|
Italiana|0|4|n|
Italianno|3|4|n|
Itim|3|4|n|
Jacquard 12|2|4|n|
Jacquard 12 Charted|2|4|n|
Jacquard 24|2|4|n|
Jacquard 24 Charted|2|4|n|
Jacquarda Bastarda 9|2|4|n|
Jacquarda Bastarda 9 Charted|2|4|n|
Jacques Francois|1|4|n|
Jacques Francois Shadow|2|4|n|
Jaini|2|4|n|
Jaini Purva|2|4|n|
Jaldi|0|47|n|
Jaro|0|4|n|
Jersey 10|2|4|n|
Jersey 10 Charted|2|4|n|
Jersey 15|2|4|n|
Jersey 15 Charted|2|4|n|
Jersey 20|2|4|n|
Jersey 20 Charted|2|4|n|
Jersey 25|2|4|n|
Jersey 25 Charted|2|4|n|
JetBrains Mono|4|12345678|ni|
Jim Nightshade|3|4|n|
Joan|1|4|n|
Jockey One|0|4|n|
Jolly Lodger|2|4|n|
Jomhuria|2|4|n|
Jomolhari|1|4|n|
Josefin Sans|0|1234567|ni|
Josefin Slab|1|1234567|ni|
Jost|0|123456789|ni|
Joti One|2|4|n|
Jua|0|4|n|
Judson|1|47|ni|
Julee|3|4|n|
Julius Sans One|0|4|n|
Junge|1|4|n|
Jura|0|34567|n|
Just Another Hand|3|4|n|
Just Me Again Down Here|3|4|n|
K2D|0|12345678|ni|
Kablammo|2|4|n|
Kadwa|1|47|n|
Kaisei Decol|1|457|n|
Kaisei HarunoUmi|1|457|n|
Kaisei Opti|1|457|n|
Kaisei Tokumin|1|4578|n|
Kalam|3|347|n|
Kalnia|1|1234567|n|
Kalnia Glaze|2|1234567|n|
Kameron|1|4567|n|
Kanchenjunga|0|4567|n|
Kanit|0|123456789|ni|
Kantumruy|0|347|n|khmer
Kantumruy Pro|0|1234567|ni|
Kapakana|3|34|n|
Karantina|2|347|n|
Karla|0|2345678|ni|
Karla Tamil Inclined|0|47|n|tamil
Karla Tamil Upright|0|47|n|tamil
Karma|1|34567|n|
Katibeh|2|4|n|
Kaushan Script|3|4|n|
Kavivanar|3|4|n|
Kavoon|2|4|n|
Kay Pho Du|1|4567|n|
Kdam Thmor Pro|0|4|n|
Keania One|2|4|n|
Kedebideri|0|456789|n|
Kelly Slab|2|4|n|
Kenia|2|4|n|
Khand|0|34567|n|
Khmer|0|4|n|khmer
Khula|0|34678|n|
Kings|3|4|n|
Kirang Haerang|2|4|n|
Kite One|0|4|n|
Kiwi Maru|1|345|n|
Klee One|3|46|n|
Knewave|2|4|n|
Kodchasan|0|234567|ni|
Kode Mono|4|4567|n|
Koh Santepheap|1|13479|n|
KoHo|0|234567|ni|
Kolker Brush|3|4|n|
Konkhmer Sleokchher|2|4|n|
Kosugi|0|4|n|
Kosugi Maru|0|4|n|
Kotta One|1|4|n|
Koulen|2|4|n|
Kranky|2|4|n|
Kreon|1|34567|n|
Kristi|3|4|n|
Krona One|0|4|n|
Krub|0|234567|ni|
Kufam|0|456789|ni|
Kulim Park|0|23467|ni|
Kumar One|2|4|n|
Kumar One Outline|2|4|n|
Kumbh Sans|0|123456789|n|
Kurale|1|4|n|
La Belle Aurore|3|4|n|
Labrada|1|123456789|ni|
Lacquer|2|4|n|
Laila|1|34567|n|
Lakki Reddy|3|4|n|
Lalezar|0|4|n|
Lancelot|2|4|n|
Langar|2|4|n|
Lateef|1|2345678|n|
Lato|0|13479|ni|
Lavishly Yours|3|4|n|
League Gothic|0|4|n|
League Script|3|4|n|
League Spartan|0|123456789|n|
Leckerli One|3|4|n|
Ledger|1|4|n|
Lekton|4|47|ni|
Lemon|2|4|n|
Lemonada|2|34567|n|
Lexend|0|123456789|n|
Lexend Deca|0|123456789|n|
Lexend Exa|0|123456789|n|
Lexend Giga|0|123456789|n|
Lexend Mega|0|123456789|n|
Lexend Peta|0|123456789|n|
Lexend Tera|0|123456789|n|
Lexend Zetta|0|123456789|n|
Libertinus Keyboard|2|4|n|
Libertinus Math|2|4|n|
Libertinus Mono|4|4|n|
Libertinus Sans|0|47|ni|
Libertinus Serif|1|467|ni|
Libertinus Serif Display|2|4|n|
Libre Barcode 128|2|4|n|
Libre Barcode 128 Text|2|4|n|
Libre Barcode 39|2|4|n|
Libre Barcode 39 Extended|2|4|n|
Libre Barcode 39 Extended Text|2|4|n|
Libre Barcode 39 Text|2|4|n|
Libre Barcode EAN13 Text|2|4|n|
Libre Baskerville|1|4567|ni|
Libre Bodoni|1|4567|ni|
Libre Caslon Display|1|4|n|
Libre Caslon Text|1|47|ni|
Libre Franklin|0|123456789|ni|
Licorice|3|4|n|
Life Savers|2|478|n|
Lilex|4|1234567|ni|
Lilita One|2|4|n|
Lily Script One|2|4|n|
Limelight|2|4|n|
Linden Hill|1|4|ni|
LINE Seed JP|0|1478|n|
Linefont|2|123456789|n|
Lisu Bosa|1|23456789|ni|
Liter|0|4|n|
Literata|1|23456789|ni|
Liu Jian Mao Cao|3|4|n|
Livvic|0|12345679|ni|
Lobster|2|4|n|
Lobster Two|2|47|ni|
Londrina Outline|2|4|n|
Londrina Shadow|2|4|n|
Londrina Sketch|2|4|n|
Londrina Solid|2|1349|n|
Long Cang|3|4|n|
Lora|1|4567|ni|
Love Light|3|4|n|
Love Ya Like A Sister|2|4|n|
Loved by the King|3|4|n|
Lovers Quarrel|3|4|n|
Luckiest Guy|2|4|n|
Lugrasimo|3|4|n|
Lumanosimo|3|4|n|
Lunasima|0|47|n|
Lusitana|1|47|n|
Lustria|1|4|n|
Luxurious Roman|2|4|n|
Luxurious Script|3|4|n|
LXGW Marker Gothic|0|4|n|
LXGW WenKai Mono TC|4|347|n|
LXGW WenKai TC|3|347|n|
M PLUS 1|0|123456789|n|
M PLUS 1 Code|4|1234567|n|
M PLUS 1p|0|1345789|n|
M PLUS 2|0|123456789|n|
M PLUS Code Latin|0|1234567|n|
M PLUS Rounded 1c|0|1345789|n|
M PLUS U|0|123456789|n|
Ma Shan Zheng|3|4|n|
Macondo|2|4|n|
Macondo Swash Caps|2|4|n|
Mada|0|23456789|n|
Madimi One|0|4|n|
Magra|0|47|n|
Maiden Orange|1|4|n|
Maitree|1|234567|n|
Major Mono Display|4|4|n|
Mako|0|4|n|
Mali|3|234567|ni|
Mallanna|0|4|n|
Maname|1|4|n|
Mandali|0|4|n|
Manjari|0|147|n|
Manrope|0|2345678|n|
Mansalva|3|4|n|
Manuale|1|345678|ni|
Manufacturing Consent|2|4|n|
Marcellus|1|4|n|
Marcellus SC|1|4|n|
Marck Script|3|4|n|
Margarine|2|4|n|
Marhey|2|34567|n|
Markazi Text|1|4567|n|
Marko One|1|4|n|
Marmelad|0|4|n|
Martel|1|2346789|n|
Martel Sans|0|2346789|n|
Martian Mono|4|12345678|n|
Marvel|0|47|ni|
Matangi|0|3456789|n|
Mate|1|4|ni|
Mate SC|1|4|n|
Matemasie|0|4|n|
Material Icons|5|4|n|
Material Icons Outlined|5|4|n|
Material Icons Round|5|4|n|
Material Icons Sharp|5|4|n|
Material Icons Two Tone|5|4|n|
Material Symbols|4|1234567|n|
Material Symbols Outlined|5|1234567|n|
Material Symbols Rounded|5|1234567|n|
Material Symbols Sharp|5|1234567|n|
Maven Pro|0|456789|n|
McLaren|2|4|n|
Mea Culpa|3|4|n|
Meddon|3|4|n|
MedievalSharp|2|4|n|
Medula One|2|4|n|
Meera Inimai|0|4|n|
Megrim|2|4|n|
Meie Script|3|4|n|
Menbere|0|1234567|n|
Meow Script|3|4|n|
Merienda|3|3456789|n|
Merienda One|3|4|n|
Merriweather|1|3456789|ni|
Merriweather Sans|0|345678|ni|
Metal|2|4|n|
Metal Mania|2|4|n|
Metamorphous|2|4|n|
Metrophobic|0|4|n|
Michroma|0|4|n|
Micro 5|2|4|n|
Micro 5 Charted|2|4|n|
Milonga|2|4|n|
Miltonian|2|4|n|
Miltonian Tattoo|2|4|n|
Mina|0|47|n|
Mingzat|0|4|n|
Miniver|2|4|n|
Miranda Sans|0|4567|ni|
Miriam Libre|0|4567|n|
Mirza|1|4567|n|
Miss Fajardose|3|4|n|
Mitr|0|234567|n|
Mochiy Pop One|0|4|n|
Mochiy Pop P One|0|4|n|
Modak|2|4|n|
Modern Antiqua|2|4|n|
Moderustic|0|345678|n|
Mogra|2|4|n|
Mohave|0|34567|ni|
Moirai One|2|4|n|
Molengo|0|4|n|
Molle|3|4|i|
Momo Signature|0|4|n|
Momo Trust Display|0|4|n|
Momo Trust Sans|0|2345678|n|
Mona Sans|0|23456789|ni|
Monda|0|4567|n|
Monofett|4|4|n|
Monomakh|2|4|n|
Monomaniac One|0|4|n|
Monoton|2|4|n|
Monsieur La Doulaise|3|4|n|
Montaga|1|4|n|
Montagu Slab|1|1234567|n|
MonteCarlo|3|4|n|
Montenegrin Gothic One|1|4|n|
Montez|3|4|n|
Montserrat|0|123456789|ni|
Montserrat Alternates|0|123456789|ni|
Montserrat Subrayada|0|47|n|
Montserrat Underline|0|123456789|ni|
Moo Lah Lah|2|4|n|
Mooli|0|4|n|
Moon Dance|3|4|n|
Moul|2|4|n|
Moulpali|0|4|n|
Mountains of Christmas|2|47|n|
Mouse Memoirs|0|4|n|
Mozilla Headline|0|234567|n|
Mozilla Text|0|234567|n|
Mr Bedfort|3|4|n|
Mr Dafoe|3|4|n|
Mr De Haviland|3|4|n|
Mrs Saint Delafield|3|4|n|
Mrs Sheppards|3|4|n|
Ms Madi|3|4|n|
Mukta|0|2345678|n|
Mukta Mahee|0|2345678|n|
Mukta Malar|0|2345678|n|
Mukta Vaani|0|2345678|n|
Mulish|0|23456789|ni|
Murecho|0|123456789|n|
MuseoModerno|2|123456789|ni|
My Soul|3|4|n|
Mynerve|3|4|n|
Mystery Quest|2|4|n|
Nabla|2|4|n|
Namdhinggo|1|45678|n|
Nanum Brush Script|3|4|n|
Nanum Gothic|0|478|n|
Nanum Gothic Coding|3|47|n|
Nanum Myeongjo|1|478|n|
Nanum Pen Script|3|4|n|
Narnoor|0|45678|n|
Nata Sans|0|123456789|n|
National Park|0|2345678|n|
Neonderthaw|3|4|n|
Nerko One|3|4|n|
Neucha|3|4|n|
Neuton|1|23478|ni|
New Amsterdam|0|4|n|
New Rocker|2|4|n|
New Tegomin|1|4|n|
News Cycle|0|47|n|
Newsreader|1|2345678|ni|
Niconne|3|4|n|
Niramit|0|234567|ni|
Nixie One|2|4|n|
Nobile|0|457|ni|
Nokora|0|123456789|n|
Norican|3|4|n|
Nosifer|2|4|n|
Notable|0|4|n|
Nothing You Could Do|3|4|n|
Noticia Text|1|47|ni|
Noto Color Emoji|0|4|n|emoji
Noto Emoji|0|34567|n|emoji
Noto Kufi Arabic|0|123456789|n|
Noto Music|0|4|n|
Noto Naskh Arabic|1|4567|n|
Noto Nastaliq Urdu|1|4567|n|
Noto Rashi Hebrew|1|123456789|n|
Noto Sans|0|123456789|ni|
Noto Sans Adlam|0|4567|n|
Noto Sans Adlam Unjoined|0|4567|n|
Noto Sans Anatolian Hieroglyphs|0|4|n|
Noto Sans Arabic|0|123456789|n|
Noto Sans Armenian|0|123456789|n|
Noto Sans Avestan|0|4|n|
Noto Sans Balinese|0|4567|n|
Noto Sans Bamum|0|4567|n|
Noto Sans Bassa Vah|0|4567|n|
Noto Sans Batak|0|4|n|
Noto Sans Bengali|0|123456789|n|
Noto Sans Bhaiksuki|0|4|n|
Noto Sans Brahmi|0|4|n|
Noto Sans Buginese|0|4|n|
Noto Sans Buhid|0|4|n|
Noto Sans Canadian Aboriginal|0|123456789|n|
Noto Sans Carian|0|4|n|
Noto Sans Caucasian Albanian|0|4|n|
Noto Sans Chakma|0|4|n|
Noto Sans Cham|0|123456789|n|
Noto Sans Cherokee|0|123456789|n|
Noto Sans Chorasmian|0|4|n|
Noto Sans Coptic|0|4|n|
Noto Sans Cuneiform|0|4|n|
Noto Sans Cypriot|0|4|n|
Noto Sans Cypro Minoan|0|4|n|
Noto Sans Deseret|0|4|n|
Noto Sans Devanagari|0|123456789|n|
Noto Sans Display|0|123456789|ni|
Noto Sans Duployan|0|47|n|
Noto Sans Egyptian Hieroglyphs|0|4|n|
Noto Sans Elbasan|0|4|n|
Noto Sans Elymaic|0|4|n|
Noto Sans Ethiopic|0|123456789|n|
Noto Sans Georgian|0|123456789|n|
Noto Sans Glagolitic|0|4|n|
Noto Sans Gothic|0|4|n|
Noto Sans Grantha|0|4|n|
Noto Sans Gujarati|0|123456789|n|
Noto Sans Gunjala Gondi|0|4567|n|
Noto Sans Gurmukhi|0|123456789|n|
Noto Sans Hanifi Rohingya|0|4567|n|
Noto Sans Hanunoo|0|4|n|
Noto Sans Hatran|0|4|n|
Noto Sans Hebrew|0|123456789|n|
Noto Sans HK|0|123456789|n|
Noto Sans Imperial Aramaic|0|4|n|
Noto Sans Indic Siyaq Numbers|0|4|n|
Noto Sans Inscriptional Pahlavi|0|4|n|
Noto Sans Inscriptional Parthian|0|4|n|
Noto Sans Javanese|0|4567|n|
Noto Sans JP|0|123456789|n|japanese
Noto Sans Kaithi|0|4|n|
Noto Sans Kannada|0|123456789|n|
Noto Sans Kawi|0|4567|n|
Noto Sans Kayah Li|0|4567|n|
Noto Sans Kharoshthi|0|4|n|
Noto Sans Khmer|0|123456789|n|
Noto Sans Khojki|0|4|n|
Noto Sans Khudawadi|0|4|n|
Noto Sans KR|0|123456789|n|korean
Noto Sans Lao|0|123456789|n|
Noto Sans Lao Looped|0|123456789|n|
Noto Sans Lepcha|0|4|n|
Noto Sans Limbu|0|4|n|
Noto Sans Linear A|0|4|n|
Noto Sans Linear B|0|4|n|
Noto Sans Lisu|0|4567|n|
Noto Sans Lycian|0|4|n|lycian
Noto Sans Lydian|0|4|n|
Noto Sans Mahajani|0|4|n|
Noto Sans Malayalam|0|123456789|n|
Noto Sans Mandaic|0|4|n|
Noto Sans Manichaean|0|4|n|
Noto Sans Marchen|0|4|n|
Noto Sans Masaram Gondi|0|4|n|
Noto Sans Math|0|4|n|
Noto Sans Mayan Numerals|0|4|n|
Noto Sans Medefaidrin|0|4567|n|
Noto Sans Meetei Mayek|0|123456789|n|
Noto Sans Mende Kikakui|0|4|n|
Noto Sans Meroitic|0|4|n|
Noto Sans Miao|0|4|n|
Noto Sans Modi|0|4|n|
Noto Sans Mongolian|0|4|n|
Noto Sans Mono|0|123456789|n|
Noto Sans Mro|0|4|n|
Noto Sans Multani|0|4|n|
Noto Sans Myanmar|0|123456789|n|
Noto Sans Nabataean|0|4|n|
Noto Sans Nag Mundari|0|4567|n|
Noto Sans Nandinagari|0|4|n|
Noto Sans New Tai Lue|0|4567|n|
Noto Sans Newa|0|4|n|
Noto Sans NKo|0|4|n|
Noto Sans NKo Unjoined|0|4567|n|
Noto Sans Nushu|0|4|n|
Noto Sans Ogham|0|4|n|
Noto Sans Ol Chiki|0|4567|n|
Noto Sans Old Hungarian|0|4|n|
Noto Sans Old Italic|0|4|n|
Noto Sans Old North Arabian|0|4|n|
Noto Sans Old Permic|0|4|n|
Noto Sans Old Persian|0|4|n|
Noto Sans Old Sogdian|0|4|n|
Noto Sans Old South Arabian|0|4|n|
Noto Sans Old Turkic|0|4|n|
Noto Sans Oriya|0|123456789|n|
Noto Sans Osage|0|4|n|
Noto Sans Osmanya|0|4|n|
Noto Sans Pahawh Hmong|0|4|n|
Noto Sans Palmyrene|0|4|n|
Noto Sans Pau Cin Hau|0|4|n|
Noto Sans Phags Pa|0|4|n|phags-pa
Noto Sans PhagsPa|0|4|n|
Noto Sans Phoenician|0|4|n|
Noto Sans Psalter Pahlavi|0|4|n|
Noto Sans Rejang|0|4|n|
Noto Sans Runic|0|4|n|
Noto Sans Samaritan|0|4|n|
Noto Sans Saurashtra|0|4|n|
Noto Sans SC|0|123456789|n|chinese-simplified
Noto Sans Sharada|0|4|n|
Noto Sans Shavian|0|4|n|
Noto Sans Siddham|0|4|n|
Noto Sans SignWriting|0|4|n|
Noto Sans Sinhala|0|123456789|n|
Noto Sans Sogdian|0|4|n|
Noto Sans Sora Sompeng|0|4567|n|
Noto Sans Soyombo|0|4|n|
Noto Sans Sundanese|0|4567|n|
Noto Sans Sunuwar|0|4|n|
Noto Sans Syloti Nagri|0|4|n|
Noto Sans Symbols|0|123456789|n|
Noto Sans Symbols 2|0|4|n|
Noto Sans Syriac|0|123456789|n|
Noto Sans Syriac Eastern|0|123456789|n|
Noto Sans Syriac Western|0|123456789|n|
Noto Sans Tagalog|0|4|n|
Noto Sans Tagbanwa|0|4|n|
Noto Sans Tai Le|0|4|n|
Noto Sans Tai Tham|0|4567|n|
Noto Sans Tai Viet|0|4|n|
Noto Sans Takri|0|4|n|
Noto Sans Tamil|0|123456789|n|
Noto Sans Tamil Supplement|0|4|n|
Noto Sans Tangsa|0|4567|n|
Noto Sans TC|0|123456789|n|chinese-traditional
Noto Sans Telugu|0|123456789|n|
Noto Sans Thaana|0|123456789|n|
Noto Sans Thai|0|123456789|n|
Noto Sans Thai Looped|0|123456789|n|
Noto Sans Tifinagh|0|4|n|
Noto Sans Tirhuta|0|4|n|
Noto Sans Ugaritic|0|4|n|
Noto Sans Vai|0|4|n|
Noto Sans Vithkuqi|0|4567|n|
Noto Sans Wancho|0|4|n|
Noto Sans Warang Citi|0|4|n|
Noto Sans Yi|0|4|n|
Noto Sans Zanabazar Square|0|4|n|
Noto Serif|1|123456789|ni|
Noto Serif Ahom|1|4|n|
Noto Serif Armenian|1|123456789|n|
Noto Serif Balinese|1|4|n|
Noto Serif Bengali|1|123456789|n|
Noto Serif Devanagari|1|123456789|n|
Noto Serif Display|1|123456789|ni|
Noto Serif Dives Akuru|1|4|n|
Noto Serif Dogra|1|4|n|
Noto Serif Ethiopic|1|123456789|n|
Noto Serif Georgian|1|123456789|n|
Noto Serif Grantha|1|4|n|
Noto Serif Gujarati|1|123456789|n|
Noto Serif Gurmukhi|1|123456789|n|
Noto Serif Hebrew|1|123456789|n|
Noto Serif Hentaigana|1|23456789|n|
Noto Serif HK|1|23456789|n|
Noto Serif JP|1|23456789|n|japanese
Noto Serif Kannada|1|123456789|n|
Noto Serif Khitan Small Script|1|4|n|
Noto Serif Khmer|1|123456789|n|
Noto Serif Khojki|1|4567|n|
Noto Serif KR|1|23456789|n|korean
Noto Serif Lao|1|123456789|n|
Noto Serif Makasar|1|4|n|
Noto Serif Malayalam|1|123456789|n|
Noto Serif Myanmar|1|123456789|n|myanmar
Noto Serif NP Hmong|1|4567|n|
Noto Serif Old Uyghur|1|4|n|
Noto Serif Oriya|1|4567|n|
Noto Serif Ottoman Siyaq|1|4|n|
Noto Serif SC|1|23456789|n|chinese-simplified
Noto Serif Sinhala|1|123456789|n|
Noto Serif Tamil|1|123456789|ni|
Noto Serif Tangut|1|4|n|
Noto Serif TC|1|23456789|n|chinese-traditional
Noto Serif Telugu|1|123456789|n|
Noto Serif Thai|1|123456789|n|
Noto Serif Tibetan|1|123456789|n|
Noto Serif Todhri|1|4|n|
Noto Serif Toto|1|4567|n|
Noto Serif Vithkuqi|1|4567|n|
Noto Serif Yezidi|1|4567|n|
Noto Traditional Nushu|0|34567|n|
Noto Znamenny Musical Notation|0|4|n|
Nova Cut|2|4|n|
Nova Flat|2|4|n|
Nova Mono|4|4|n|
Nova Oval|2|4|n|
Nova Round|2|4|n|
Nova Script|2|4|n|
Nova Slim|2|4|n|
Nova Square|2|4|n|
NTR|0|4|n|
Numans|0|4|n|
Nunito|0|23456789|ni|
Nunito Sans|0|23456789|ni|
Nuosu SIL|0|4|n|
Odibee Sans|2|4|n|
Odor Mean Chey|1|4|n|
Offside|2|4|n|
Oi|2|4|n|
Ojuju|0|2345678|n|
Old Standard TT|1|47|ni|
Oldenburg|2|4|n|
Ole|3|4|n|
Oleo Script|2|47|n|
Oleo Script Swash Caps|2|47|n|
Onest|0|123456789|n|
Oooh Baby|3|4|n|
Open Sans|0|345678|ni|
Oranienbaum|1|4|n|
Orbit|0|4|n|
Orbitron|0|456789|n|
Oregano|2|4|ni|
Orelega One|2|4|n|
Orienta|0|4|n|
Original Surfer|2|4|n|
Oswald|0|234567|n|
Outfit|0|123456789|n|
Over the Rainbow|3|4|n|
Overlock|2|479|ni|
Overlock SC|2|4|n|
Overpass|0|123456789|ni|
Overpass Mono|4|34567|n|
Ovo|1|4|n|
Oxanium|2|2345678|n|
Oxygen|0|347|n|
Oxygen Mono|4|4|n|
Pacifico|3|4|n|
Padauk|0|47|n|
Padyakke Expanded One|1|4|n|
Palanquin|0|1234567|n|
Palanquin Dark|0|4567|n|
Palette Mosaic|2|4|n|
Pangolin|3|4|n|
Paprika|2|4|n|
Parastoo|1|4567|n|
Parisienne|3|4|n|
Parkinsans|0|345678|n|
Passero One|2|4|n|
Passion One|2|479|n|
Passions Conflict|3|4|n|
Pathway Extreme|0|123456789|ni|
Pathway Gothic One|0|4|n|
Patrick Hand|3|4|n|
Patrick Hand SC|3|4|n|
Pattaya|0|4|n|
Patua One|2|4|n|
Pavanam|0|4|n|
Paytone One|0|4|n|
Peddana|1|4|n|
Peralta|1|4|n|
Permanent Marker|3|4|n|
Petemoss|3|4|n|
Petit Formal Script|3|4|n|
Petrona|1|123456789|ni|
Phetsarath|0|47|n|lao
Philosopher|0|47|ni|
Phudu|2|3456789|n|
Piazzolla|1|123456789|ni|
Piedra|2|4|n|
Pinyon Script|3|4|n|
Pirata One|2|4|n|
Pixelify Sans|2|4567|n|
Plaster|2|4|n|
Platypi|1|345678|ni|
Play|0|47|n|
Playball|2|4|n|
Playfair|1|3456789|ni|
Playfair Display|1|456789|ni|
Playfair Display SC|1|479|ni|
Playpen Sans|3|12345678|n|
Playpen Sans Arabic|3|12345678|n|
Playpen Sans Deva|3|12345678|n|
Playpen Sans Hebrew|3|12345678|n|
Playpen Sans Thai|3|12345678|n|
Playwrite AR|3|1234|n|
Playwrite AR Guides|3|4|n|
Playwrite AT|3|1234|ni|
Playwrite AT Guides|3|4|ni|
Playwrite AU NSW|3|1234|n|
Playwrite AU NSW Guides|3|4|n|
Playwrite AU QLD|3|1234|n|
Playwrite AU QLD Guides|3|4|n|
Playwrite AU SA|3|1234|n|
Playwrite AU SA Guides|3|4|n|
Playwrite AU TAS|3|1234|n|
Playwrite AU TAS Guides|3|4|n|
Playwrite AU VIC|3|1234|n|
Playwrite AU VIC Guides|3|4|n|
Playwrite BE VLG|3|1234|n|
Playwrite BE VLG Guides|3|4|n|
Playwrite BE WAL|3|1234|n|
Playwrite BE WAL Guides|3|4|n|
Playwrite BR|3|1234|n|
Playwrite BR Guides|3|4|n|
Playwrite CA|3|1234|n|
Playwrite CA Guides|3|4|n|
Playwrite CL|3|1234|n|
Playwrite CL Guides|3|4|n|
Playwrite CO|3|1234|n|
Playwrite CO Guides|3|4|n|
Playwrite CU|3|1234|n|
Playwrite CU Guides|3|4|n|
Playwrite CZ|3|1234|n|
Playwrite CZ Guides|3|4|n|
Playwrite DE Grund|3|1234|n|
Playwrite DE Grund Guides|3|4|n|
Playwrite DE LA|3|1234|n|
Playwrite DE LA Guides|3|4|n|
Playwrite DE SAS|3|1234|n|
Playwrite DE SAS Guides|3|4|n|
Playwrite DE VA|3|1234|n|
Playwrite DE VA Guides|3|4|n|
Playwrite DK Loopet|3|1234|n|
Playwrite DK Loopet Guides|3|4|n|
Playwrite DK Uloopet|3|1234|n|
Playwrite DK Uloopet Guides|3|4|n|
Playwrite ES|3|1234|n|
Playwrite ES Deco|3|1234|n|
Playwrite ES Deco Guides|3|4|n|
Playwrite ES Guides|3|4|n|
Playwrite FR Moderne|3|1234|n|
Playwrite FR Moderne Guides|3|4|n|
Playwrite FR Trad|3|1234|n|
Playwrite FR Trad Guides|3|4|n|
Playwrite GB J|3|1234|ni|
Playwrite GB J Guides|3|4|ni|
Playwrite GB S|3|1234|ni|
Playwrite GB S Guides|3|4|ni|
Playwrite HR|3|1234|n|
Playwrite HR Guides|3|4|n|
Playwrite HR Lijeva|3|1234|n|
Playwrite HR Lijeva Guides|3|4|n|
Playwrite HU|3|1234|n|
Playwrite HU Guides|3|4|n|
Playwrite ID|3|1234|n|
Playwrite ID Guides|3|4|n|
Playwrite IE|3|1234|n|
Playwrite IE Guides|3|4|n|
Playwrite IN|3|1234|n|
Playwrite IN Guides|3|4|n|
Playwrite IS|3|1234|n|
Playwrite IS Guides|3|4|n|
Playwrite IT Moderna|3|1234|n|
Playwrite IT Moderna Guides|3|4|n|
Playwrite IT Trad|3|1234|n|
Playwrite IT Trad Guides|3|4|n|
Playwrite MX|3|1234|n|
Playwrite MX Guides|3|4|n|
Playwrite NG Modern|3|1234|n|
Playwrite NG Modern Guides|3|4|n|
Playwrite NL|3|1234|n|
Playwrite NL Guides|3|4|n|
Playwrite NO|3|1234|n|
Playwrite NO Guides|3|4|n|
Playwrite NZ|3|1234|n|
Playwrite NZ Basic|3|1234|n|
Playwrite NZ Basic Guides|3|4|n|
Playwrite NZ Guides|3|4|n|
Playwrite PE|3|1234|n|
Playwrite PE Guides|3|4|n|
Playwrite PL|3|1234|n|
Playwrite PL Guides|3|4|n|
Playwrite PT|3|1234|n|
Playwrite PT Guides|3|4|n|
Playwrite RO|3|1234|n|
Playwrite RO Guides|3|4|n|
Playwrite SK|3|1234|n|
Playwrite SK Guides|3|4|n|
Playwrite TZ|3|1234|n|
Playwrite TZ Guides|3|4|n|
Playwrite US Modern|3|1234|n|
Playwrite US Modern Guides|3|4|n|
Playwrite US Trad|3|1234|n|
Playwrite US Trad Guides|3|4|n|
Playwrite VN|3|1234|n|
Playwrite VN Guides|3|4|n|
Playwrite ZA|3|1234|n|
Playwrite ZA Guides|3|4|n|
Pliant|0|123456789|ni|
Plus Jakarta Sans|0|2345678|ni|
Pochaevsk|2|4|n|
Podkova|1|45678|n|
Poetsen One|2|4|n|
Poiret One|2|4|n|
Poller One|2|4|n|
Poltawski Nowy|1|4567|ni|
Poly|1|4|ni|
Pompiere|2|4|n|
Ponnala|2|4|n|
Ponomar|2|4|n|
Pontano Sans|0|34567|n|
Poor Story|2|4|n|
Poppins|0|123456789|ni|
Port Lligat Sans|0|4|n|
Port Lligat Slab|1|4|n|
Potta One|2|4|n|
Pragati Narrow|0|47|n|
Praise|3|4|n|
Prata|1|4|n|
Preahvihear|0|4|n|
Press Start 2P|2|4|n|
Pridi|1|234567|n|
Princess Sofia|3|4|n|
Prociono|1|4|n|
Prompt|0|123456789|ni|
Prosto One|2|4|n|
Protest Guerrilla|2|4|n|
Protest Revolution|2|4|n|
Protest Riot|2|4|n|
Protest Strike|2|4|n|
Proza Libre|0|45678|ni|
PT Mono|4|4|n|
PT Sans|0|47|ni|
PT Sans Caption|0|47|n|
PT Sans Narrow|0|47|n|
PT Serif|1|47|ni|
PT Serif Caption|1|4|ni|
Public Sans|0|123456789|ni|
Puppies Play|3|4|n|
Puritan|0|47|ni|
Purple Purse|2|4|n|
Pushster|2|4|n|
Qahiri|0|4|n|
Quando|1|4|n|
Quantico|0|47|ni|
Quattrocento|1|47|n|
Quattrocento Sans|0|47|ni|
Questrial|0|4|n|
Quicksand|0|34567|n|
Quintessential|3|4|n|
Qwigley|3|4|n|
Qwitcher Grypen|3|47|n|
Racing Sans One|2|4|n|
Radio Canada|0|34567|ni|
Radio Canada Big|0|4567|ni|
Radley|1|4|ni|
Rajdhani|0|34567|n|
Rakkas|2|4|n|
Raleway|0|123456789|ni|
Raleway Dots|2|4|n|
Ramabhadra|0|4|n|
Ramaraja|1|4|n|
Rambla|0|47|ni|
Rammetto One|2|4|n|
Rampart One|2|4|n|
Ramsina|1|4|n|
Ranchers|2|4|n|
Rancho|3|4|n|
Ranga|2|47|n|
Rasa|1|34567|ni|
Rationale|0|4|n|
Ravi Prakash|2|4|n|
Readex Pro|0|234567|n|
Recursive|0|3456789|n|
Red Hat Display|0|3456789|ni|
Red Hat Mono|4|34567|ni|
Red Hat Text|0|34567|ni|
Red Rose|2|34567|n|
Redacted|2|4|n|
Redacted Script|2|347|n|
Reddit Mono|4|23456789|n|
Reddit Sans|0|23456789|ni|
Reddit Sans Condensed|0|23456789|n|
Redressed|3|4|n|
Reem Kufi|0|4567|n|
Reem Kufi Fun|0|4567|n|
Reem Kufi Ink|0|4|n|
Reenie Beanie|3|4|n|
Reggae One|2|4|n|
REM|0|123456789|ni|
Rethink Sans|0|45678|ni|
Revalia|2|4|n|
Rhodium Libre|1|4|n|
Ribeye|2|4|n|
Ribeye Marrow|2|4|n|
Righteous|2|4|n|
Risque|2|4|n|
Road Rage|2|4|n|
Roboto|0|123456789|ni|
Roboto Condensed|0|123456789|ni|
Roboto Flex|0|4|n|
Roboto Mono|4|1234567|ni|
Roboto Serif|1|123456789|ni|
Roboto Slab|1|123456789|n|
Rochester|3|4|n|
Rock 3D|2|4|n|
Rock Salt|3|4|n|
RocknRoll One|0|4|n|
Rokkitt|1|123456789|ni|
Romanesco|3|4|n|
Ropa Sans|0|4|ni|
Rosario|0|34567|ni|
Rosarivo|1|4|ni|
Rouge Script|3|4|n|
Rowdies|2|347|n|
Rozha One|1|4|n|
Rubik|0|3456789|ni|
Rubik 80s Fade|2|4|n|
Rubik Beastly|2|4|n|
Rubik Broken Fax|2|4|n|
Rubik Bubbles|2|4|n|
Rubik Burned|2|4|n|
Rubik Dirt|2|4|n|
Rubik Distressed|2|4|n|
Rubik Doodle Shadow|2|4|n|
Rubik Doodle Triangles|2|4|n|
Rubik Gemstones|2|4|n|
Rubik Glitch|2|4|n|
Rubik Glitch Pop|2|4|n|
Rubik Iso|2|4|n|
Rubik Lines|2|4|n|
Rubik Maps|2|4|n|
Rubik Marker Hatch|2|4|n|
Rubik Maze|2|4|n|
Rubik Microbe|2|4|n|
Rubik Mono One|0|4|n|
Rubik Moonrocks|2|4|n|
Rubik Pixels|2|4|n|
Rubik Puddles|2|4|n|
Rubik Scribble|2|4|n|
Rubik Spray Paint|2|4|n|
Rubik Storm|2|4|n|
Rubik Vinyl|2|4|n|
Rubik Wet Paint|2|4|n|
Ruda|0|456789|n|
Rufina|1|47|n|
Ruge Boogie|3|4|n|
Ruluko|0|4|n|
Rum Raisin|0|4|n|
Ruslan Display|2|4|n|
Russo One|0|4|n|
Ruthie|3|4|n|
Ruwudu|1|4567|n|
Rye|2|4|n|
Sacramento|3|4|n|
Sahitya|1|47|n|
Sail|2|4|n|
Saira|0|123456789|ni|
Saira Condensed|0|123456789|n|
Saira Extra Condensed|0|123456789|n|
Saira Semi Condensed|0|123456789|n|
Saira Stencil|2|123456789|ni|
Saira Stencil One|2|4|n|
Salsa|2|4|n|
Sanchez|1|4|ni|
Sancreek|2|4|n|
Sankofa Display|0|4|n|
Sansation|0|347|ni|
Sansita|0|4789|ni|
Sansita Swashed|2|3456789|n|
Sarabun|0|12345678|ni|
Sarala|0|47|n|
Sarina|2|4|n|
Sarpanch|0|456789|n|
Sassy Frass|3|4|n|
Satisfy|3|4|n|
Savate|0|23456789|ni|
Sawarabi Gothic|0|4|n|
Sawarabi Mincho|1|4|n|
Scada|0|47|ni|
Scheherazade New|1|4567|n|
Schibsted Grotesk|0|456789|ni|
Schoolbell|3|4|n|
Science Gothic|0|123456789|n|
Scope One|1|4|n|
Scoutie Sans|0|2345678|ni|
Seaweed Script|2|4|n|
Secular One|0|4|n|
Sedan|1|4|ni|
Sedan SC|1|4|n|
Sedgwick Ave|3|4|n|
Sedgwick Ave Display|3|4|n|
Sekuya|2|4|n|
Sen|0|45678|n|
Send Flowers|3|4|n|
Sevillana|2|4|n|
Seymour One|0|4|n|
Shadows Into Light|3|4|n|
Shadows Into Light Two|3|4|n|
Shafarik|2|4|n|
Shalimar|3|4|n|
Shantell Sans|2|345678|ni|
Shanti|0|4|n|
Share|0|47|ni|
Share Tech|0|4|n|
Share Tech Mono|4|4|n|
Shippori Antique|0|4|n|
Shippori Antique B1|0|4|n|
Shippori Mincho|1|45678|n|
Shippori Mincho B1|1|45678|n|
Shizuru|2|4|n|
Shojumaru|2|4|n|
Short Stack|3|4|n|
Shrikhand|2|4|n|
Siemreap|0|4|n|khmer
Sigmar|2|4|n|
Sigmar One|2|4|n|
Signika|0|34567|n|
Signika Negative|0|34567|n|
Silkscreen|2|47|n|
Simonetta|2|49|ni|
Single Day|2|4|n|
Sintony|0|47|n|
Sirin Stencil|2|4|n|
Sirivennela|0|4|n|
Six Caps|0|4|n|
Sixtyfour|4|4|n|
Sixtyfour Convergence|4|4|n|
Skranji|2|47|n|
Slabo 13px|1|4|n|
Slabo 27px|1|4|n|
Slackey|2|4|n|
Slackside One|3|4|n|
Smokum|2|4|n|
Smooch|3|4|n|
Smooch Sans|0|123456789|n|
Smythe|2|4|n|
SN Pro|0|23456789|ni|
Sniglet|2|48|n|
Snippet|0|4|n|
Snowburst One|2|4|n|
Sofadi One|2|4|n|
Sofia|3|4|n|
Sofia Sans|0|123456789|ni|
Sofia Sans Condensed|0|123456789|ni|
Sofia Sans Extra Condensed|0|123456789|ni|
Sofia Sans Semi Condensed|0|123456789|ni|
Solitreo|3|4|n|
Solway|1|34578|n|
Sometype Mono|4|4567|ni|
Song Myung|1|4|n|
Sono|0|2345678|n|
Sonsie One|2|4|n|
Sora|0|12345678|n|
Sorts Mill Goudy|1|4|ni|
Sour Gummy|0|123456789|ni|
Source Code Pro|4|23456789|ni|
Source Sans 3|0|23456789|ni|
Source Sans Pro|0|234679|ni|
Source Serif 4|1|23456789|ni|
Source Serif Pro|1|234679|ni|
Space Grotesk|0|34567|n|
Space Mono|4|47|ni|
Special Elite|2|4|n|
Special Gothic|0|4567|n|
Special Gothic Condensed One|0|4|n|
Special Gothic Expanded One|0|4|n|
Spectral|1|2345678|ni|
Spectral SC|1|2345678|ni|
Spicy Rice|2|4|n|
Spinnaker|0|4|n|
Spirax|2|4|n|
Splash|3|4|n|
Spline Sans|0|34567|n|
Spline Sans Mono|4|34567|ni|
Squada One|2|4|n|
Square Peg|3|4|n|
Sree Krushnadevaraya|1|4|n|
Sriracha|3|4|n|
Srisakdi|2|47|n|
Staatliches|2|4|n|
Stack Sans Headline|0|234567|n|
Stack Sans Notch|0|234567|n|
Stack Sans Text|0|234567|n|
Stalemate|3|4|n|
Stalinist One|2|4|n|
Stardos Stencil|2|47|n|
Stick|0|4|n|
Stick No Bills|0|2345678|n|
Stint Ultra Condensed|1|4|n|
Stint Ultra Expanded|1|4|n|
STIX Two Math|1|4|n|
STIX Two Text|1|4567|ni|
Stoke|1|34|n|
Story Script|0|4|n|
Strait|0|4|n|
Strichpunkt Sans|0|456789|n|
Style Script|3|4|n|
Stylish|0|4|n|
Sue Ellen Francisco|3|4|n|
Suez One|1|4|n|
Sulphur Point|0|347|n|
Sumana|1|47|n|
Sunflower|0|357|n|
Sunshiney|3|4|n|
Supermercado One|2|4|n|
Sura|1|47|n|
Suranna|1|4|n|
Suravaram|1|4|n|
SUSE|0|123456789|ni|
SUSE Mono|0|12345678|ni|
Suwannaphum|1|13479|n|
Swanky and Moo Moo|3|4|n|
Syncopate|0|47|n|
Syne|0|45678|n|
Syne Mono|4|4|n|
Syne Tactile|2|4|n|
Tac One|0|4|n|
Tagesschrift|2|4|n|
Tai Heritage Pro|1|47|n|
Tajawal|0|2345789|n|
Tangerine|3|47|n|
Tapestry|3|4|n|
Taprom|2|4|n|
TASA Explorer|0|45678|n|
TASA Orbiter|0|45678|n|
Tauri|0|4|n|
Taviraj|1|123456789|ni|
Teachers|0|45678|ni|
Teko|0|34567|n|
Tektur|2|456789|n|
Telex|0|4|n|
Tenali Ramakrishna|0|4|n|
Tenor Sans|0|4|n|
Text Me One|0|4|n|
Texturina|1|123456789|ni|
Thasadith|0|47|ni|
The Girl Next Door|3|4|n|
The Nautigal|3|47|n|
Tienne|1|479|n|
TikTok Sans|0|3456789|n|
Tillana|2|45678|n|
Tilt Neon|2|4|n|
Tilt Prism|2|4|n|
Tilt Warp|2|4|n|
Timmana|0|4|n|
Tinos|1|47|ni|
Tiny5|0|4|n|
Tiro Bangla|1|4|ni|
Tiro Devanagari Hindi|1|4|ni|
Tiro Devanagari Marathi|1|4|ni|
Tiro Devanagari Sanskrit|1|4|ni|
Tiro Gurmukhi|1|4|ni|
Tiro Kannada|1|4|ni|
Tiro Tamil|1|4|ni|
Tiro Telugu|1|4|ni|
Tirra|0|456789|n|
Titan One|2|4|n|
Titillium Web|0|234679|ni|
Tomorrow|0|123456789|ni|
Tourney|2|123456789|ni|
Trade Winds|2|4|n|
Train One|2|4|n|
Triodion|2|4|n|
Trirong|1|123456789|ni|
Trispace|0|12345678|n|
Trocchi|1|4|n|
Trochut|2|47|ni|
Truculenta|0|123456789|n|
Trykker|1|4|n|
Tsukimi Rounded|0|34567|n|
Tuffy|0|47|ni|
Tulpen One|2|4|n|
Turret Road|2|234578|n|
Twinkle Star|3|4|n|
Ubuntu|0|3457|ni|
Ubuntu Condensed|0|4|n|
Ubuntu Mono|4|47|ni|
Ubuntu Sans|0|12345678|ni|
Ubuntu Sans Mono|4|4567|ni|
Uchen|1|4|n|
Ultra|1|4|n|
Unbounded|0|23456789|n|
Uncial Antiqua|2|4|n|
Underdog|2|4|n|
Unica One|2|4|n|
UnifrakturCook|2|7|n|
UnifrakturMaguntia|2|4|n|
Unkempt|2|47|n|
Unlock|2|4|n|
Unna|1|47|ni|
UoqMunThenKhung|1|4|n|
Updock|3|4|n|
Urbanist|0|123456789|ni|
Valley Sans|0|123456789|ni|
Vampiro One|2|4|n|
Varela|0|4|n|
Varela Round|0|4|n|
Varta|0|34567|n|
Vast Shadow|1|4|n|
Vazirmatn|0|123456789|n|
Vend Sans|0|34567|ni|
Vesper Libre|1|4579|n|
Viaoda Libre|2|4|n|
Vibes|2|4|n|
Vibur|3|4|n|
Victor Mono|4|1234567|ni|
Vidaloka|1|4|n|
Viga|0|4|n|
Vina Sans|2|4|n|
Voces|0|4|n|
Volkhov|1|47|ni|
Vollkorn|1|456789|ni|
Vollkorn SC|1|4679|n|
Voltaire|0|4|n|
VT323|4|4|n|
Vujahday Script|3|4|n|
Waiting for the Sunrise|3|4|n|
Wallpoet|2|4|n|
Walter Turncoat|3|4|n|
Warnes|2|4|n|
Water Brush|3|4|n|
Waterfall|3|4|n|
Wavefont|2|123456789|n|
WDXL Lubrifont JP N|0|4|n|
WDXL Lubrifont SC|0|4|n|
WDXL Lubrifont TC|0|4|n|
Wellfleet|1|4|n|
Wendy One|0|4|n|
Whisper|3|4|n|
WindSong|3|45|n|
Winky Rough|0|3456789|ni|
Winky Sans|0|3456789|ni|
Wire One|0|4|n|
Wittgenstein|1|456789|ni|
Wix Madefor Display|0|45678|n|
Wix Madefor Text|0|45678|ni|
Work Sans|0|123456789|ni|
Workbench|4|4|n|
Xanh Mono|4|4|ni|
Yaldevi|0|234567|n|
Yanone Kaffeesatz|0|234567|n|
Yantramanav|0|134579|n|
Yarndings 12|2|4|n|
Yarndings 12 Charted|2|4|n|
Yarndings 20|2|4|n|
Yarndings 20 Charted|2|4|n|
Yatra One|2|4|n|
Yellowtail|3|4|n|
Yeon Sung|2|4|n|
Yeseva One|2|4|n|
Yesteryear|3|4|n|
Yomogi|3|4|n|
Young Serif|1|4|n|
Yrsa|1|34567|ni|
Ysabeau|0|123456789|ni|
Ysabeau Infant|0|123456789|ni|
Ysabeau Office|0|123456789|ni|
Ysabeau SC|0|123456789|n|
Yuji Boku|1|4|n|
Yuji Hentaigana Akari|3|4|n|
Yuji Hentaigana Akebono|3|4|n|
Yuji Mai|1|4|n|
Yuji Syuku|1|4|n|
Yusei Magic|0|4|n|
Yuyu|3|4|n|
Yuyu Short|3|4|n|
Zain|0|234789|ni|
Zalando Sans|0|23456789|ni|
Zalando Sans Expanded|0|23456789|ni|
Zalando Sans SemiExpanded|0|23456789|ni|
ZCOOL KuaiLe|0|4|n|
ZCOOL QingKe HuangYou|0|4|n|
ZCOOL XiaoWei|0|4|n|
Zen Antique|1|4|n|
Zen Antique Soft|1|4|n|
Zen Dots|2|4|n|
Zen Kaku Gothic Antique|0|34579|n|
Zen Kaku Gothic New|0|34579|n|
Zen Kurenaido|0|4|n|
Zen Loop|2|4|ni|
Zen Maru Gothic|0|34579|n|
Zen Old Mincho|1|45679|n|
Zen Tokyo Zoo|2|4|n|
Zeyada|3|4|n|
Zhi Mang Xing|3|4|n|
Zilla Slab|1|34567|ni|
Zilla Slab Highlight|1|47|n|`;

let catalog: FontMeta[] | null = null;
let byFamily: Map<string, FontMeta> | null = null;

function parse(): FontMeta[] {
    if (catalog) return catalog;
    const list: FontMeta[] = [];
    const index = new Map<string, FontMeta>();
    for (const line of PACKED.split('\n')) {
        const [family, cat, weights, styles, subset] = line.split('|');
        const meta: FontMeta = {
            family,
            id: family.toLowerCase().replace(/\s+/g, '-'),
            category: FONT_CATEGORIES[Number(cat)] ?? 'sans-serif',
            weights: [...weights].map((d) => Number(d) * 100),
            hasNormal: styles.includes('n'),
            hasItalic: styles.includes('i'),
            subset: subset || 'latin',
        };
        list.push(meta);
        index.set(meta.family.toLowerCase(), meta);
    }
    catalog = list;
    byFamily = index;
    return list;
}

/** Every family, sorted by name. Parsed on first call, then cached. */
export function fontCatalog(): readonly FontMeta[] {
    return parse();
}

/**
 * Look up a family by name, case-insensitively.
 *
 * Undefined for anything not in the catalog — a document may name a font that
 * was never on the CDN, or one embedded by its author — so callers must treat
 * a miss as "unknown", not "invalid".
 */
export function lookupFont(family: string): FontMeta | undefined {
    parse();
    return byFamily!.get(family.trim().toLowerCase());
}
