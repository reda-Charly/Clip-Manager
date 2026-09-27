# Clip Manager - Board & Clip ID Editor

An Electron desktop application for managing board and clip IDs in XML configuration files.

## Features

- **Select Boards**: Choose from available boards (P1-P18) displayed in a grid
- **Select Clips**: Choose from available clips (CLIP-001 to CLIP-041) displayed in a grid
- **Edit IDs**: Modify board and clip IDs through input fields
- **Live Preview**: See your changes in real-time before saving
- **XML Integration**: Directly read from and write to XML files
- **Modern UI**: Clean, responsive interface with visual feedback

## Prerequisites

- Node.js (v14 or higher)
- npm (comes with Node.js)

## Installation

1. Navigate to the clip-manager directory:
```bash
cd "c:\Users\benta\Documents\OGC APP\clip-manager"
```

2. Install dependencies:
```bash
npm install
```

## Usage

1. Start the application:
```bash
npm start
```

2. Click "Select XML File" and choose your `dbWCT.xml` file

3. Select boards by clicking on them in the "Select Boards" grid

4. Select clips by clicking on them in the "Select Clips" grid

5. Enter new IDs in the input fields that appear for selected items

6. Review your changes in the "Preview Selected Data" section

7. Click "Save Changes to XML" to update the file

## Project Structure

```
clip-manager/
├── main.js           # Electron main process
├── index.html        # Application UI
├── renderer.js       # Renderer process logic
├── package.json      # Project configuration
└── README.md         # This file
```

## How It Works

- **Main Process** (`main.js`): Handles file operations and IPC communication
- **Renderer Process** (`renderer.js`): Manages UI interactions and data manipulation
- **UI** (`index.html`): Provides the interface for selection and editing

## XML File Format

The application expects XML files with the following structure:
- `<boards>` section containing `<board>` elements with `<name>` and `<id>`
- `<clips>` section containing `<clip>` elements with `<name>` and `<id>`

## Building for Distribution

To create a distributable package:
```bash
npm run build
```

The built application will be in the `dist/` directory.

## Troubleshooting

- If the application doesn't start, ensure Node.js is properly installed
- If file loading fails, check that the XML file has the correct structure
- If saving fails, ensure you have write permissions for the XML file

## Notes

- The application creates a backup of your original XML file is not automatic - consider backing up your file before making changes
- Changes are applied immediately when you click "Save Changes to XML"
- The application preserves the original XML formatting as much as possible
