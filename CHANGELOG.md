# Ghost Calligrapher changelog

Every change, by day (newest first), then by section of the app: Editor, Downloads & exports, PDF tools,
OCR & fonts, Handwriting & signatures, Forms & signing, Site & layout, and Fixes.
The same list is on the site at https://jcodomo.github.io/calligrapher2/changelog.html
(rebuilt with `node tools/changelog-page.mjs`).

## 2026-11-25

### PDF tools
- **PDF to Excel (new).** Tools > PDF to Excel, PDF to Excel in the editor's Convert & Optimize bar, or Excel (.xlsx) in the Download menu. Tables keep their rows and columns: columns are found from the white channels that run down a table and from its ruled lines (cell borders), so tightly fitted columns from programs like Excel still come apart, a row with empty cells stays lined up, and a wrapped description goes in its column. Amounts become real numbers that add up (commas, $, minus signs, (brackets), trailing minus, %), dates become dates, and account numbers, ZIP codes and other figures with leading zeros stay as typed. Bold stays bold, columns are sized to fit. One sheet per page, or every page on one sheet. Scanned pages are read with OCR. Checked against PDFs printed by Excel itself (with borders, without, with gridlines, 8 pt): 8 of 8 converted back exactly, 2,086 of 2,086 cells, and the files open in Excel with no repair prompt.
- **PDF to PowerPoint (new).** Tools > PDF to PowerPoint, the editor's Convert bar, or PowerPoint (.pptx) in the Download menu. One slide per page that looks just like it - the page's drawings, pictures and colours are the slide's picture - with every line of text as its own editable text box at its place, in the page's font, size, weight, slant and colour. Turned text stays in the picture; a page with only text has no picture at all. Scanned pages (and scans with a hidden OCR layer) are read, the words are wiped off the picture with the paper colour around them and put back as editable text. Made with PptxGenJS 3.12 (loaded only when you convert, checked with an integrity hash); decks are packed again with compression, about 10 times smaller than PptxGenJS writes them.
- **Protect PDF (new): lock a PDF with a password, in the browser.** Tools > Protect, or Protect in the editor's Convert & Optimize bar. The file is encrypted with AES-256 (the strongest PDF standard, revision 6), which Acrobat, Chrome, Edge, Firefox, Preview and phone readers open with the password; nothing is uploaded. You can also turn off printing, copying text, or changes. Checked with two independent PDF readers (pdf.js and Poppler): the right password opens it with every page, word, form field and title intact, a wrong or missing one is refused, and no text can be read from the file without it.
- **Flatten keeps the text.** Flatten used to turn every page into a picture, so the text could no longer be selected or found. Now filled-in form fields and the drawn look of comments and markups are fixed onto the page, and the page itself stays as it was: sharp, real text, small file. Links keep working; a note without a drawn look stays a note. If a page can't be done that way, it falls back to pictures as before.
- **Unlock keeps the words and the paper size.** The unlocked copy's pages came out twice the size (in points) and its text could not be selected; pages now keep their size and every word goes back on as real (invisible) text, so it can be searched and copied.

### Editor
- **Drawings are real PDF comments in the editable download.** With "PDF — keep it editable", highlights, pen strokes, lines, arrows, underlines, strike-throughs, rectangles and ellipses are saved as PDF annotations with their own drawn look (vector, not a picture), so Acrobat, Preview, Edge and Chrome show them exactly as in the editor and list them as comments you can select, change or delete. A highlight dragged along a line of text is a text Highlight (see-through, the words stay readable); other strokes are Ink; shapes are Square and Circle. The plain PDF download still fixes them onto the page. Checked in pdf.js, Chrome's own PDF viewer and pypdf.
- **Typing could be lost in a line you were editing.** If the page was drawn again while you typed (a font arriving, a background font match), the text box was replaced by a new one that did not take keys, while the editor still thought you were typing; a double-click did nothing, and what you typed never reached the line (so its old words stayed in the download). The new box now goes straight back into typing mode, with the caret at the end. Found by the editing stress test (the first line edited in the first document, in about 4 of 5 runs of some seeds); the test now checks that what you type reaches the line.
- An edited line whose page number was stored as "none" (the first page) is found again when its old words are taken out of the file.
- **A redaction no longer costs the rest of the page its text.** A redacted or blurred page still becomes a picture in the download, so nothing under the box survives, but every word outside the boxes now goes back on as invisible real text at its place, so the rest of the page can still be selected, copied and searched. Words under a redaction, a blur or a line you changed with Edit text are not put back; text boxes you added on such a page are searchable too (they were not).

### Downloads & exports
- Word export: a space the PDF really has between two words is kept even when the gap it leaves is tiny (text squeezed to fit its box).

### Tests
- New: tools/stress-office.js, a hard test of PDF to Excel and PDF to PowerPoint with known answers: a two-page bank statement (wrapped descriptions, empty cells, negative balances in brackets, account number and ZIP kept as text), an invoice ($, %, totals in bold), the statement as a scan (OCR) and on turned pages, random tables in many shapes (amounts, currency, brackets, minus, percent, dates, codes with leading zeros, empty cells, 7-11 pt, landscape pages), a 60-page document, and slides checked box by box (place within 2 pt, size, font, weight, slant, colour, picture without the text, turned text kept, text-only page without a picture, a scan made editable). Seven seeds: every check and every cell right (about 15,000 cells a run). Plus tools/excel-made-pdfs.ps1, which has Excel print sample workbooks to PDF so they can be converted back and compared cell by cell.
- tools/stress-random.js waits for a file dropped in the Files view to finish loading before it checks the pages (it sometimes checked too early).
- New: tools/stress-features.js, a feature-by-feature check of the editor against what online PDF editors offer, on a PDF with real text and on the same pages as a scan with no text: add text, highlight, underline, strike, pen, line, arrow, rectangle, ellipse, white-out, redact, blur, date, tick, note, text and tick fields, pictures. Each tool is used on a fresh copy through the page, the download is compared with the original pixel by pixel (ink where the tool was used, nothing else moved, page 2 untouched) and word by word (all words still selectable, redacted ones gone, added text findable, notes are real PDF comments, fields real form fields, file size sensible); then every download format, 60 drawings with Undo all / Redo all, a fillable PDF (its own fields stay fillable in Editable PDF and are fixed in place in PDF), Edit text plus a redaction on one page, and the page tools (Protect, Unlock, Flatten, Compress, Number pages, Watermark). 300 of 300 and 42 of 42 pass; the earlier editing tests still pass (Edit text 325/325 and 326/326, random merge/split/extract 6/6).

## 2026-11-23

### Editor
- **Clicking a line no longer changes it.** With Edit text, a line you click into stays exactly as it is on the page (no white cover, no font swap) until you actually type, or change its font, size, colour or place. A line you clicked and left alone is not redrawn in the download either.
- **A label and its value are separate boxes on scans.** A form row read as one line ("Beneficiary Bank ABA Number      011000015") is split at the wide gap, so clicking the number edits only the number and the label next to it is untouched.

### OCR & fonts
- **Better font matching on scans:** the matcher now measures how far the letters lean, so upright text is never matched to an italic (before, a blurry scan of Times could come out as "Old Standard TT Italic"), and italics are tried across more families when the line does lean. A close call goes to the fonts most documents use (Times, Arial, Calibri, Cambria and Courier lookalikes). On a test set of blurred, speckled lines in nine fonts, 100 of 144 are matched to the right family and slant (was 71); Times New Roman 15 of 16 (was 11), upright text taken for italic 0 times (was 8).
- Each box is matched on its own words only, so a value column no longer throws off the match for its label.
- **The fonts of a scanned page are learned and downloaded as soon as it is read.** When Edit text reads a scan, its longest lines (from each column) are matched in the background and every font they point to is downloaded, so the first click is quick and a toast says which fonts the page uses. Each box you click is then matched with the votes of the lines in its own column and of the whole page, so a short box (a few digits, one word) gets the page's font instead of a guess, and a form with labels in one font and values in another keeps them apart. The page waits until every candidate font has downloaded before it votes, so the answer no longer depends on which fonts happened to arrive first, and display faces that are rare in business documents (Playfair Display, Old Standard TT, Courier Prime and the like) win only when they are clearly closer. On scanned test forms (11 rows, every box clicked): Times, Arial, Calibri, Courier and Georgia 20 of 20 boxes each, a form with Arial labels and Times values 20 of 20, Times italic 15 of 20, Cambria 11 of 20 (the rest go to a close serif such as Gelasio).
- Georgia is matched to Gelasio, its metric twin.
- New stress tests: tools/stress-scan-edit.js (scanned forms in seven fonts, every box clicked) and tools/stress-font-match.js (144 scan-like lines), plus tools/engine-matrix.mjs (16,000 checks of the handwriting engine, the scanned-look pixels and the 1-bit packer, run in Node).

### Fixes
- **Redo works after Undo when a box is in a script font.** A text box grows to fit its font once the font has drawn (a wide script such as Great Vibes); that resize counted as a new edit, so Redo right after an Undo had nothing to bring back and the box was missing from the download. Resizes to fit are now part of the step they belong to. Found by the editing stress test; after the fix 4 runs of 6 documents pass 1,943 of 1,944 checks (the one left is two random boxes typed on top of each other, read in mixed order by Word).

## 2026-11-22

### OCR & fonts
- **A progress bar on every OCR:** whenever text is read from a picture (PDF OCR, scanned-page text editing, Word export of scans, page numbers, duplicate pages), a bar across the top and a card show the engine, how many readings are done, the percent and the time left; it says when it is finished.
- **RapidOCR in the background, better on photos:** RapidOCR now runs in a background worker, so the page never freezes while it reads; tilted photos are straightened first, word spaces come from the gaps between letters, and specks are no longer read as text.
- **Read it again with RapidOCR:** running PDF OCR a second time on the same files reads them with RapidOCR (the PP-OCRv4 models, downloaded once, about 15 MB, then kept in the browser), and the text layer is drawn from its lines; a third run goes back to Tesseract. When a scanned page has been read for editing, the card offers "Read again with RapidOCR" (and back).
- **Scanned pages read better when the page is hard to read:** when the reader is unsure of a page (a phone photo, grey or shadowed paper), it reads the page again from a cleaned copy (greyscale, contrast stretched between the darkest and lightest pixels, a dark page flipped to dark text on light) and keeps the surer reading. Same size as the page, so the text layer and the words you edit still line up. This is the same clean-up the mortgage suite's document reader uses. Used by PDF OCR (searchable PDF) and by Edit text on a scan.
- **Figures read right in English text:** when you edit a scanned line, letters read for digits inside an amount are fixed ("$1, 2O4.5O" becomes "$1,204.50"), and a space after a thousands comma is closed. Only amounts change (two or more digits with a comma or point), and only when every OCR language is English.
- **OCR stress test** (tools/stress-ocr.js): letters and invoices with known text and amounts drawn as printed, scanned, photographed, shadowed and dark-mode pages, read by the app and by plain Tesseract with the same model. 30 pages: photos 90.1% of words right (plain 89.0%), shadowed pages 94.7% (93.8%) with 40 of 42 amounts (39); printed, scanned and dark pages as before (99.4%, 97.3%, 99.7%).

## 2026-11-21

### Editor
- **Edited text is really gone from the saved file.** When you change a line with Edit text, the original words are now taken out of the PDF itself, not only covered with a white patch, so they can no longer be selected, copied or found by search in the download. Everything else on the page stays real text, and text after the edit on the same line stays exactly where it was.
- **Your edits are real text too:** words in text boxes and edited lines are saved as searchable, copyable text under their picture, so the PDF can be searched and a Word download contains them.
- **The page no longer jumps when you click a line:** the text toolbar stays on one row (it scrolls sideways on narrow screens) instead of wrapping onto a second row and pushing the page down.
- **A line that grows past the page edge is marked** with a red dashed outline, and the first time you are told to press ⤢ Fit or shorten it.

### Downloads & exports
- **Word downloads keep your edits:** before, a Word file of an edited PDF had the old words and none of the new ones.

### Fixes
- **New stress test for editing** (tools/stress-edits.js): documents made from a seed in every standard font, lines edited and new text boxes typed in ten fonts, undo and redo, then the download checked page by page; every look, quality and format downloaded and checked; real documents checked line by line for a change of look when clicked.

## 2026-11-20

### PDF tools
- **New Merge workspace:** **Files** shows one card per file (a stacked card for files with several pages) with its name in a coloured tag and its page count; **Pages** shows every page with the file it came from. Drag cards to reorder (Ctrl+Z undoes), tick cards (or **Select all**) to rotate or delete them, use the **+** between cards or the **Add** tile to put more PDFs, pictures, Word, Excel or PowerPoint files exactly there, and **Download merged PDF** saves it with the Download panel's look and quality.
- **New Split workspace:** a **✂** between every two pages - click one and the document is cut there: the cut turns into a solid line and each part gets its own shaded group. Click it again to join. **Cut every page** and **Clear cuts** are one click; **Split into N files** saves a ZIP of the parts (named by their pages). **Extract** takes the ticked pages out as one PDF. Edits made in the editor go into every part.

### Downloads & exports
- **Merge, Split and Organize are much faster:** page pictures in these views are drawn straight from the PDF at thumbnail size (instead of a full-size page each, made one at a time), several at once and only for the pages on screen; a 60-page file shows its first screen at once, a cut redraws in about 10 ms, and splitting it into 60 files takes under half a second. Page sizes are read all at once when a file opens, the duplicate-page check no longer draws every page at full size, and full-size pages are drawn in the background only after the thumbnails. Split no longer rebuilds and reloads the whole document before it opens.
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
- **Tab icon:** the pen-stroke icon is kept in a darker navy (mtgcalc uses the same icon in a lighter blue), and the What's new page shows it too.
- **Free-form entry everywhere:** number boxes take 12.5pt, 1,200, 50%, 10+2 and the arrow keys; date and time boxes take Sep 15 2026, 9/15/26, today, +30, 3pm (with a calendar button); slider numbers can be clicked and typed; the handwriting seed takes any text; page-number boxes take "Page 7" or roman numerals.
- **What's new page** (changelog.html, linked at the bottom of every page): every change day by day, each day split by section, with a button per section. Rebuilt from CHANGELOG.md with `node tools/changelog-page.mjs`.

### Handwriting & signatures
- **More signature pad settings:** pen style (ballpoint, fine liner, fountain pen, felt marker, brush pen), any ink colour, slant, width, ink flow, pressure & speed on or off, the signing line on or off, Redo (also Ctrl+Y) next to Undo, and PNG or SVG download of the signature. Your choices are remembered.

### Fixes
- Duplicate-page detection and sort by page number used an old way of calling the OCR reader after the update merge and failed.
- Choosing a paper size failed on a page with nothing on it; export errors now show a message instead of "Building PDF…".
- The handwriting pad's style-name box ran off the screen on phones.
- **Edited PDF text stays on its line.** Opening a line with Edit text could move it up or down and make it look bigger: the editor lined it up by the ascent the PDF's text layer gives (often 0.75) while the browser draws the font with the ascent in the font file (often 0.95). The line is now placed by the font it is really drawn with, so its baseline lands exactly on the original - on screen and in the download.
- **Typed characters match the line's weight.** A character the PDF's embedded font doesn't contain (a "4" typed into "2021" when the document has no bold 4) was drawn in plain regular Arimo. Fonts with no usable name ("CIDFont+F1") are now matched from their own drawing of the line, so missing characters come out in the closest family, bold when the line is bold (Carlito Bold for Calibri Bold), and the letter spacing is refitted so the line keeps its width.
- **No more faint boxes when printing.** Your edits are saved as a see-through layer over the original page, and the browser wrote black under its clear parts. Printers and many PDF viewers scale the colour and the see-through parts separately, so that black bled into the edges: a grey frame around every added text box, white-out and patch, and a dark fringe around text, signatures and highlights. The clear parts next to each edge now carry the colour beside them (also in the handwriting PDF with no background), so nothing shows at any print or zoom size.
- **A page saved turned, then turned back upright, now downloads upright.** A PDF page stored with a 90/180/270 turn that you rotated back to straight kept its old turn in the download (found by the random stress test).
- **Downloading right after rotating a picture page works.** Rotating a page made from a picture (JPG/PNG) and downloading before it was redrawn failed with nothing saved; the picture is now drawn again first.
- **Opening a new document leaves Merge / Split** and clears the previous document's scissors cuts.
- **Stress tests:** tools/stress-pages.js (55 fixed checks) and tools/stress-random.js (random documents - page counts, paper sizes, turned pages, pictures - and random reorder / rotate / delete / drop-in actions, checked page by page against a model, with the seed printed so any failure can be replayed).

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
