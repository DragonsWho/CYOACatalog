// src/components/Footer/PatreonIcon.jsx
// Version: 1.1.0
// Description: Updated Patreon icon component with official logo

import React from 'react'
import SvgIcon from '@mui/material/SvgIcon'

const PatreonIcon = (props) => (
    <SvgIcon {...props} viewBox="0 0 1080 1080">
        <path
            fill="currentColor"
            d="M1033.05,324.45c-0.19-137.9-107.59-250.92-233.6-291.7c-156.48-50.64-362.86-43.3-512.28,27.2C106.07,145.41,49.18,332.61,47.06,519.31c-1.74,153.5,13.58,557.79,241.62,560.67c169.44,2.15,194.67-216.18,273.07-321.33c55.78-74.81,127.6-95.94,216.01-117.82C929.71,603.22,1033.27,483.3,1033.05,324.45z"
        />
    </SvgIcon>
)

const PatreonWordmark = (props) => (
    <SvgIcon {...props} viewBox="0 0 1826.3 619.9">
        <path
            fill="currentColor"
            d="M202.5,226c0-10,7.4-16.8,19-16.8h55.5c50.3,0,84.5,27.7,84.5,68.4c0,40-33.9,69.7-84.5,69.7h-7.7 c-19.4,0-29.4,10-29.4,26.1V419c0,12.9-7.4,21-18.7,21c-11.3,0-18.7-8.1-18.7-21V226z M239.9,283.8c0,20.3,10.3,30,30,30h4.8 c27.7,0,48.1-11.3,48.1-36.1s-20.3-36.1-48.1-36.1H270c-19.7,0-30,9.7-30,30V283.8z M361.6,422.2c0,10.6,7.4,17.7,18.7,17.7 c7.4,0,14.2-4.8,18.1-14.8l6.8-18.1c5.5-14.5,15.2-21.3,25.8-21.3h61.3c10.6,0,20.3,6.8,25.8,21.3l6.8,18.1 c3.9,10,10.6,14.8,18.1,14.8c11.3,0,18.7-7.1,18.7-17.7c0-2.9-0.6-6.5-1.9-10l-73.2-190.4c-4.5-11.6-14.8-17.4-24.8-17.4 s-20.3,5.8-24.8,17.4l-73.2,190.4C362.2,415.8,361.6,419.3,361.6,422.2z M432.9,335.7c0-3.5,1-6.8,2.6-11.6l13.9-38.4 c2.6-7.4,7.1-11,12.3-11s9.7,3.5,12.3,11l13.9,38.4c1.6,4.8,2.6,8.1,2.6,11.6c0,9.7-5.5,16.5-20,16.5h-17.4 C438.4,352.2,432.9,345.4,432.9,335.7z M549.4,226.7c0-10.3,7.4-17.4,19.4-17.4h148.4c11.9,0,19.4,7.1,19.4,17.4 s-7.4,17.4-19.4,17.4h-24.8c-19.7,0-30.3,10-30.3,32.9v141.7c0,13.2-7.4,21.3-19,21.3c-11.6,0-19-8.1-19-21.3V277 c0-22.9-10.6-32.9-30.3-32.9h-24.8C556.8,244.1,549.4,237,549.4,226.7z M771.4,419c0,12.9,7.4,21,18.7,21s18.7-8.1,18.7-21v-51.3 c0-14.5,8.4-20.7,18.7-20.7h2.6c6.8,0,13.6,4.2,17.7,10.3l49,72c4.5,6.8,10.3,10.6,17.7,10.6c9.7,0,17.4-8.1,17.4-17.7 c0-3.9-1.3-8.1-4.2-12.3l-32.6-45.8c-3.9-5.5-5.5-10-5.5-13.9c0-8.1,7.1-13.9,15.5-20c15.2-11.3,31.6-26.1,31.6-54.5 c0-39.7-31-66.5-82-66.5h-64.9c-11.6,0-18.7,6.8-18.7,16.8V419z M808.8,280.9v-9.7c0-21,11-29.7,27.7-29.7h16.1 c27.7,0,45.5,10.3,45.5,34.2s-18.7,34.8-46.5,34.8h-15.2C819.8,310.6,808.8,301.9,808.8,280.9z M984.7,418.3V226 c0-10,7.1-16.8,18.7-16.8h122c11.6,0,18.7,6.8,18.7,16.8s-7.1,16.8-18.7,16.8h-77.1c-15.2,0-26.1,9-26.1,26.1v7.1 c0,17.1,11,26.1,26.1,26.1h59.7c11.6,0,18.7,6.8,18.7,16.8s-7.1,16.8-18.7,16.8h-57.4c-15.2,0-28.4,9.4-28.4,28.4v9 c0,19,13.2,28.4,28.4,28.4h74.9c11.6,0,18.7,6.8,18.7,16.8s-7.1,16.8-18.7,16.8h-122C991.8,435.1,984.7,428.3,984.7,418.3z M1166.3,322.2c0-69.7,52.3-117.8,113.6-117.8c61.3,0,113.6,48.1,113.6,117.8S1341.2,440,1279.9,440 C1218.6,440,1166.3,391.9,1166.3,322.2z M1208.9,322.2c0,49,29,80.3,71,80.3c41.9,0,71-31.3,71-80.3c0-49.4-29-80.3-71-80.3 C1238,241.8,1208.9,272.8,1208.9,322.2z M1438.3,419c0,12.9,7.4,21,18.7,21s18.7-8.1,18.7-21v-98.7c0-11.9,7.1-17.7,14.5-17.7 c5.8,0,10.6,3.2,14.2,9l61.9,103.6c8.4,14.2,16.1,24.8,31.9,24.8c15.2,0,26.1-11,26.1-28.7V225.4c0-12.9-7.4-21-18.7-21 c-11.3,0-18.7,8.1-18.7,21v98.7c0,11.9-7.1,17.7-14.5,17.7c-5.8,0-10.7-3.2-14.2-9l-61.9-103.6c-8.4-14.2-16.1-24.8-31.9-24.8 c-15.2,0-26.1,11-26.1,28.7V419z"
        />
    </SvgIcon>
)

export default PatreonIcon
PatreonWordmark
