Hi, this is the frontend for CYOA.cafe (NSFW), an online catalog I'm stubbornly trying to create. 

<details>
  <summary># How to run it</summary>

1. Download Visual Studio
2. Clone this Git
3. npm install
4. in the .vscode folder, create 
launch.json
```
{
    "version": "0.2.0",
    "configurations": [
        {
            "type": "chrome",
            "request": "launch",
            "name": "Launch Chrome against localhost",
            "url": "http://localhost:3000",
            "webRoot": "${workspaceFolder}",
            "preLaunchTask": "npm: dev"
        }
    ]
}
```
and tasks.json
```
{
    "version": "2.0.0",
    "tasks": [
        {
            "type": "npm",
            "script": "dev",
            "problemMatcher": {
                "owner": "custom",
                "pattern": {
                    "regexp": "^$"
                },
                "background": {
                    "activeOnStart": true,
                    "beginsPattern": "^.*VITE.*",
                    "endsPattern": "^.*ready in.*$"
                }
            },
            "label": "npm: dev",
            "detail": "vite",
            "isBackground": true
        }
    ]
}
```
5. Press F5! it should* run!

* Or not. Currently it may not display content because the API is blocking external requests. Maybe this will change in the future or I'll post the back-end for local launch.
</details>
<details>
<summary># How to contribute </summary>
For now, it's simple and obvious enough so you can add a few ideas to Issues or, better yet, implement a couple!
Or support the project on [boosty](https://boosty.to/dragonswhore) or [patreon!](https://www.patreon.com/DragonsWhore)
Either way - you can ask me here or find me in the [discord channel](https://discord.gg/9stHNfEskG)!
</details>
<details>
<summary># ROADMAP</summary>
Current tasks:

* Getting rid of bugs.
* Switching to typescript
* changing CMS
* customizing servers
* workflow customization (I think it's mostly about me >_>). 
* Must have a dev server with shared access.

For version 1.0 we need to:
* search system by tags
* sfw\nsfw switcher in header
* warning about NSFW
* registration via reddit, mail and anonymously with delay.
* figure out lossless picture conversion.
* fix picture cropping
* Move to cloudflare to increase speed and availability.
* minimal user account customization. display nickname, change password, avatar

Further goals:
* Optimizing the code and getting rid of unnecessary queries. 
* Notifications (games from your favorite author, reply to your comment, etc.)
* Personal messages in the form of a small chat. probably integration with discord (if possible).
* Builds saver. With comments and the ability to insert small illustrations.
* Notes and dices for static CYOA
* Integration of interactive CYOA, possibility to upload them to the server

* Section for all kinds of instructions and manuals for creating CYOA
* A section for CYOAs developers where they can brag about their progress, organize polls, etc.
* Section for game search
* Section for game stories
* Section for translators
* Possibly integration of all this as a feed as an alternative mode of the site. 
 

</details>