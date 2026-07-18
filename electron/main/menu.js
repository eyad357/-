'use strict';

const { Menu, app } = require('electron');
const { isProd } = require('../security/security');

function buildMenu(mainWindow) {
  const template = [
    {
      label: 'ملف',
      submenu: [
        { label: 'خروج', role: 'quit' },
      ],
    },
    {
      label: 'عرض',
      submenu: isProd()
        ? [
            { label: 'تكبير/تصغير الشاشة', role: 'togglefullscreen' },
          ]
        : [
            { role: 'reload' },
            { role: 'forceReload' },
            { role: 'toggleDevTools' },
            { type: 'separator' },
            { role: 'togglefullscreen' },
          ],
    },
    {
      label: 'مساعدة',
      submenu: [
        {
          label: 'حول البرنامج',
          click: () => {
            const { dialog } = require('electron');
            dialog.showMessageBox(mainWindow, {
              title: 'حول البرنامج',
              message: 'نظام التقويم والاعتماد المدرسي',
              detail: `الإصدار ${app.getVersion()}`,
            });
          },
        },
      ],
    },
  ];

  return Menu.buildFromTemplate(template);
}

module.exports = { buildMenu };
