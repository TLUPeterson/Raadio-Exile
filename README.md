# Raadio-Exile

## Setup

create .env file with desired prefix and your bot token
```
prefix= "!"
token= "" # Discord Bot token
SPOTIFY_CLIENT_ID=
SPOTIFY_CLIENT_SECRET=
ANNOUNCEMENT_INTERVAL_MS=1800000 # time in milliseconds (3600000 for 1 hour)
keya="" #fmstream key
keyb="" #fmstream key
YOUTUBE_COOKIE='APISID=...'
```

run "npm install" in terminal
might nede to run "npm i libsodium-wrappers"

and run bot with "node eksiilsus.js"

"!raadio" open discord ui for channel selection
 
## YouTube
Add  ```YOUTUBE_COOKIE=''``` to .env 

To get the cookie:
1. Open youtube.com in browser
2. Open developer console (F12)
3. type ```document.cookie```
4. copy whole string ```'APISID=...'``` into the .env
