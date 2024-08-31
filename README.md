Hi, this is the frontend for CYOA.cafe (NSFW), an online catalog I'm stubbornly trying to create. 


# How to run it

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

# How to contribute 