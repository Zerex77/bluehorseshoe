# Ticker fonts

Terminus Font 4.39 (bold, 12/14/16/18/20 px), converted from BDF to Pillow's bitmap format
(`.pil` + `.pbm`). Pixel fonts land exactly on the LED grid, so text stays crisp and even.

Copyright (C) 2014 Dimitar Toshkov Zhekov. Licensed under the SIL Open Font License, Version 1.1
(https://openfontlicense.org). The fonts may be bundled with software and hardware, including
products that are sold, as long as this notice stays with them and the fonts aren't sold by themselves.

To rebuild from the BDF files:
    python3 -c "from PIL import BdfFontFile; BdfFontFile.BdfFontFile(open('ter-u14b.bdf','rb')).save('ter-u14b')"
