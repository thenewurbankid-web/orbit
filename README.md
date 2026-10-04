# watch-dog

The phone side of a personal Paperclip status board. Open it from the QR code on the board running
on the Mac: the page reads the pairing offer from the link, shows a reply code to paste back into
the Mac, and then connects directly over WebRTC. Without a pairing link it does nothing.

The page makes no server calls of its own and stores nothing secret. It works from any static
host; all paths are relative. Libraries load from jsDelivr (three.js) and cdnjs (qrcodejs, Mac side
only).
