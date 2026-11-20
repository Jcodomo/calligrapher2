# Ghost Calligrapher changelog

Every change, by day (newest first), then by section of the app: Editor, Downloads & exports, PDF tools,
OCR & fonts, Handwriting & signatures, Forms & signing, Site & layout, and Fixes.
The same list is on the site at https://jcodomo.github.io/calligrapher2/changelog.html
(rebuilt with `node tools/changelog-page.mjs`).

## 2026-11-20

### Downloads & exports
- **Live download preview:** the Download panel shows the first page exactly as it will be saved - built by the real download, so the look, quality, watermark, page numbers, paper size, turn and page choice all show as you change them - with its size in inches or pixels and about how big the file is per page. Word and text downloads say there's no picture preview.
- **The preview stays at the top of the Download panel** while you scroll its settings, so every change shows straight away; the ⤢ button opens a full-size, sharp view.
- **Scan look:** a button in the Download panel opens every scan style - Clean, Slightly scanned, Scanned, Photocopy, B&W scan, Grayscale, Photographed and Photographed on a countertop - with fine-tuning for tilt, tilt variation, brightness, contrast, blur, sharpness, noise, yellowing, blemishes, colours and a dark scanner border. All of it shows in the live preview before you download.
- **Photographed looks:** the page as a phone photo - perspective, shadow, uneven lighting and a slight warm cast - or lying on a countertop, with sliders for each.
- **Wrinkles and folds:** crumpled-paper creases and one to three fold lines (two makes a letter fold).
- **Straighten:** tilted pages (crooked scans and photos) are turned level before the look is applied.
- **Randomize** with a **severity** slider: new random settings for the chosen style, as mild or as strong as the slider says.

### OCR & fonts
- **Edit scanned text in a matching font.** With Edit text on a scanned page (or a page with an OCR text layer, or a PDF font with an unknown name), the page is read with OCR and each line opens as editable text in the closest matching font. The match compares the line's ink with 39 font families in regular, bold and italic; tested 32 of 32 on sharp text and 23 of 32 exact (28 in the top three) on small, blurry, noisy text.
- **Closest matches first in the font list,** each with a match percentage; picking one also sets its weight and slant.
- **PDF text keeps bold and italic** from the font's own settings even when its name doesn't say so; more font names are recognised (Arial Narrow, Arial Black, Impact, Aptos, Avenir, Optima, Century and others).
- **Letter spacing is matched** so an edited line keeps the original width.

### Editor
- **Open almost any file:** drop or choose text, Markdown, CSV, JSON, XML, web pages, Word (.docx), Excel (.xlsx), PowerPoint (.pptx), OpenDocument, RTF, emails (.eml), SVG, TIFF, BMP, ICO, AVIF or a ZIP of them. Each is read in the browser and you choose: open it in the editor, or save it as a PDF, a picture or a Word document. Files that can't be read (old .doc/.xls/.ppt, HEIC on most browsers, Pages, Photoshop, audio and video, programs, RAR) get a plain explanation and what to do instead.
- **Blur brush** (Draw → Blur brush): paint over names, numbers or faces to blur them, with brush width and blur strength. In the download the page is flattened like a redaction, so the text under the blur is gone from the file, not just hidden.
- **Document recognition:** when you open a document that looks like one you edited before - even a different file, such as the same form for another person - Ghost Calligrapher offers to apply the same edits (text, signatures, boxes, drawings, blurs and form entries). It compares the first page's layout and words; Undo takes the applied edits back, and "Don't suggest it" stops the offer for that document. The last 40 edited documents are remembered, only in your browser.
- **Alignment guides:** while you drag an object, a faint line shows when its edges or centre line up with another object, a line of the page's text or the middle of the page, and the object snaps there. The line goes away when you let go; hold Alt to move freely.
- **Recent documents keep your work:** the 10 most recent documents keep their edits, page order, turned pages and filled fields and reopen exactly as you left them (marked "Edited").

### Site & layout
- **Free-form entry everywhere:** number boxes take 12.5pt, 1,200, 50%, 10+2 and the arrow keys; date and time boxes take Sep 15 2026, 9/15/26, today, +30, 3pm (with a calendar button); slider numbers can be clicked and typed; the handwriting seed takes any text; page-number boxes take "Page 7" or roman numerals.
- **What's new page** (changelog.html, linked at the bottom of every page): every change day by day, each day split by section, with a button per section. Rebuilt from CHANGELOG.md with `node tools/changelog-page.mjs`.

### Handwriting & signatures
- **More signature pad settings:** pen style (ballpoint, fine liner, fountain pen, felt marker, brush pen), any ink colour, slant, width, ink flow, pressure & speed on or off, the signing line on or off, Redo (also Ctrl+Y) next to Undo, and PNG or SVG download of the signature. Your choices are remembered.

### Fixes
- Duplicate-page detection and sort by page number used an old way of calling the OCR reader after the update merge and failed.
- Choosing a paper size failed on a page with nothing on it; export errors now show a message instead of "Building PDF…".
- The handwriting pad's style-name box ran off the screen on phones.

## 2026-11-19

### Downloads & exports
- **Clean PDF downloads have no box lines:** added text and check boxes print as plain text and a tick; no field outlines, grey labels or text-box lines.
- **More options** in the download panel: pages (all, this page, odd, even, or a list like 1-3, 5, 8-), leave out blank pages, paper size (Letter, Legal, Tabloid, A4, A5), turn pages, page numbers, watermark (preset or your own text), picture resolution (150 / 300 / 600 dpi) and file name. Pages left out are really removed from the file.
- **New looks:** Grayscale, and Black & white scan (true 1-bit pages, about 90% smaller).
- **Faster exports:** PDF libraries load only when needed, pictures are encoded in a background worker, and scanned looks render in a pool of workers so the page never freezes; each page gets its own tilt.
- **Scan engines:** a Rust/WASM pixel pipeline (blur, sharpen, paper tint, grain, specks) and an optional Realistic engine (ImageMagick).
- **PDF details:** title, author, subject and keywords, with optional removal of the software name and dates.
- A scanned-look .zip uses JPG (PNG of a grainy scan was 20 times larger).

### PDF tools
- Split reads each file once (about 7 times faster); merge copies per file.
- Compress: Basic and Strong shrink embedded photos and keep text selectable; Extreme turns pages into pictures.

### OCR & fonts
- **OCR tool rebuilt** (in the browser): 123 languages, several at once; Fast or Best (300 dpi); text layer laid over the original page when the page didn't need changing; cleanup (remove background, straighten, clean specks and borders, turn sideways pages upright); force OCR; one PDF per file or combined.

### Site & layout
- The font search and the OCR language list keep a fixed size while you type and say when nothing matches.
- The header and the editor bar fit at every width (the navigation folds into the menu earlier; the phone bar no longer pushes the close button off the screen).
- Leaving a page closes its pop-up (signature pad and others), and Back skips tool links that only forward somewhere.

## 2026-11-17

### Downloads & exports
- **PDF download keeps the original pages** instead of redrawing them as pictures (a 124 KB quote no longer comes out at 3.6 MB with compression marks); edits are laid on top and form fields are filled in and fixed in place.
- **Download panel:** Format (PDF, editable PDF, Word, PNG, JPG), Look (Clean by default, Slightly scanned, Scanned, Photocopy, your scan settings) and Quality, remembered between visits.
- **Exact quality by default:** turned PDF pages stay vector, picture pages keep the original picture file, redacted pages are drawn fresh at 300 dpi and your edits at 360 dpi.
- New formats: All pages as pictures (.zip) and Text only (.txt).
- Scanned looks keep the exact page size (the tilt used to grow pages by a few points).

### Fixes
- Downloading before a page finished drawing shows a message instead of an error.
- Pictures to PDF and Clean up & upscale open empty with their own Add buttons.
- Sort by page number no longer mistakes a notification badge or a stray number for a page number, and only sorts when the numbers look like a real numbering.

## 2026-11-16

### Site & layout
- **New site:** a top bar with a Tools menu, a home page with a drop zone and every tool by category, a page for each tool, and a recent files page. Renamed to Ghost Calligrapher.
- **Themes:** a soft light theme and the original dark one, following the system setting, with a toggle.

### Editor
- **A full document editor:** toolbar (Select, Text, Sign, Date, Tick, Fields, Image, Shapes, Draw, Highlight, Underline, Strikethrough, Note, Whiteout, Edit text), page thumbnails, every page in one scrolling view, zoom, undo / redo and keyboard shortcuts.
- **Workspace modes:** Edit & Annotate, Fill & Sign, Organize Pages, Convert & Optimize.
- **Edit Text in the PDF's own font:** edits render in the PDF's embedded font; Delete removes text.
- **Text boxes:** live editing, resize handles, wrapping, size buttons, half-point sizes, Fit, line and letter spacing.
- **Organize Pages** on the open document: reorder, turn, duplicate, delete, blank page, add PDFs; duplicate check and sort by page number in its toolbar.
- Recent files kept: 10.

### OCR & fonts
- **Font library:** about 100 fonts on demand, with stand-ins that keep the same width as Arial, Times, Courier, Calibri, Cambria and Georgia; PDF fonts are matched to the closest family. Find and save a PDF's own fonts.
- Faster OCR: up to four readers at once, kept for the next run; pages that already have text are left as they are.

### Handwriting & signatures
- **Draw pad** for signatures (kept 60 days) and **teach it your handwriting** so new text is written in your style.
- Signature fine-tuning (threshold, smoothness, exactness, realism, thickness), import from PDFs with crop.
- Export and import saved signatures and styles; a signatures & styles manager; picture backgrounds (white, none or paper).

### Forms & signing
- Find fields on a page: blank lines become text fields and empty squares become checkboxes.
- Fillable PDFs with radio buttons and dropdowns; side-by-side form view.
- **Fill & Sign link:** turns a form into a web page others fill in and sign, and can publish it as a link.
- Open and sign files sent from the mortgage document builder.

### PDF tools
- Watermark removal (keeps pages vector; pictures by colour or brush).
- PDF to Word, PDF to pictures (72-600 dpi), pictures to PDF with page size and margins, AI clean-up and upscaling.
- Pictures workspace; Pages and Full page views; find duplicate pages; sort by page number (OCR for screenshots); both right in the page bar.

### Fixes
- Flatten, Compress and Redact kept pages at the render size (a Letter page came out 17 x 22 in).
- Compress keeps the smaller file and leaves a PDF alone when it can't get smaller.

## 2026-11-14

### Handwriting & signatures
- The handwriting model runs in a background worker; strokes are variable-width pen ribbons, so nib, ink flow and realism settings apply.
- Six more hands (15 in all); save up to 10 signatures; paste a signature screenshot to trace it.
- The neural handwriting model is published with the site (with permission and attribution).

### Editor
- Place several signatures and text boxes; move, resize, delete, opacity; colour-coded signers.
- Live inline editing, a DocuSign-style date stamp, a check mark that toggles to an X.
- Drawing tools: pen, highlighter, rectangle, line, arrow.
- Form builder: text, date, checkbox and signature fields.
- Scanned look rebuilt: colour space, border, rotation, brightness, contrast, noise and yellowing, with a live preview.

### PDF tools
- Page tools: reorder, turn, duplicate, delete, merge, extract, split, crop, number pages, watermark, compress, flatten, PDF to and from pictures, redact, unlock, OCR, Fill Form, Text to PDF.
- Edit the PDF's real text.

### Downloads & exports
- Fillable PDF download (real form fields); download choices: flattened PDF, fillable PDF, PNG, SVG.

### Site & layout
- Recent documents remembered (last 5 at the time) with thumbnails.
- Script addresses carry a version so a new deploy always loads fresh.

### Fixes
- The handwriting came out upside down; the newest render now always wins.

## 2026-11-13

### Handwriting & signatures
- **Calligrapher 2.0:** an original handwriting engine (Rust compiled to WebAssembly) with presets, alignment, paper guides, colours, a write-on animation, SVG / PNG export and share links.
- Writing and Signature modes; style, speed, legibility, thickness; realism (vary each letter, natural movement, ink flow, tilt).
- A cursive capital alphabet and signature flourishes; 13 named styles.
- Import a signature picture and trace it to a clean vector (handles shadows and uneven paper), with style matching.
- A neural handwriting model (Graves RNN) in the browser, with Simple and Advanced views and the 9 original hands.

### Editor
- Open a PDF or picture and place writing on its pages; Scan & finish (scanned look, blemishes, blur, sharpen, resolution) and paper textures.

### Fixes
- Stray connector marks after cursive joins; the neural model's attention window.
