// `<input type="file" webkitdirectory>` is what turns a file picker into a FOLDER
// picker, and it is not in React's typings. React passes unknown LOWERCASE
// attributes straight to the DOM, so the attribute works; only TypeScript needs
// telling. `directory` rides along for the non-WebKit spelling.
import 'react';

declare module 'react' {
  interface InputHTMLAttributes<T> {
    webkitdirectory?: string;
    directory?: string;
  }
}
