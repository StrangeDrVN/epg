# @freearhey/storage-js

## Installation

```sh
npm install @freearhey/storage-js
```

## Usage

```js
import { Storage } from '@freearhey/storage-js'

const storage = new Storage('./temp')

await storage.save('example.txt', 'Lorem ipsum')

const files = await storage.list()

console.log(files) // example.txt
```

## Test

```sh
npm test
```

## LICENSE

[MIT](LICENSE)
