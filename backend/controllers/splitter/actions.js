const { execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const firebaseAdmin = require('firebase-admin');

firebaseAdmin.initializeApp({
  credential: firebaseAdmin.credential.applicationDefault(),
  databaseURL: 'https://sound-whale.firebaseio.com',
});
const firebaseStorage = firebaseAdmin.storage().bucket('sound-whale.appspot.com');
const firebaseFirestore = firebaseAdmin.firestore().collection('music').doc('music-doc');

const parseFilename = require('../../utils/parseFilename');

// 1 hour
const REMOVE_FILE_TIMER = 60000000 * 6;
// const REMOVE_FILE_TIMER = 5000;

const postSplitMusic = async ctx => {
  console.log('postSplitMusic: enter');
  const { path: filePath, destination } = ctx.request.file;
  const { filename, fileExtension } = parseFilename(filePath);

  // upload to firebase-store
  firebaseStorage.upload(filePath)
    .then(() => console.log('Init track has been uploaded to the firebase storage'));

  // split music
  const splitProcess = execFile('sh', [path.resolve(__dirname, '../../sh/split_music.sh')], {
    env: {
      AUDIO_INPUT: filePath,
      AUDIO_OUTPUT: destination,
      OUTPUT_ACCOMPANIMENT: `${destination}/${filename}/accompaniment.wav`,
      OUTPUT_VOCALS: `${destination}/${filename}/vocals.wav`,
    },
  });
  // eslint-disable-next-line no-use-before-define
  await promiseFromChildProcess(splitProcess);

  // convert result to needed format
  if (fileExtension !== 'wav') {
    const convertProcess = execFile('sh', [path.resolve(__dirname, '../../sh/convert.sh')], {
      env: {
        INPUT_ACCOMPANIMENT: `${destination}/${filename}/accompaniment.wav`,
        INPUT_VOCALS: `${destination}/${filename}/vocals.wav`,
        OUTPUT_ACCOMPANIMENT: `${destination}/${filename}/accompaniment.${fileExtension}`,
        OUTPUT_VOCALS: `${destination}/${filename}/vocals.${fileExtension}`,
      },
    });
    // eslint-disable-next-line no-use-before-define
    await promiseFromChildProcess(convertProcess);
  }

  // upload parsed music to firebase
  // accompaniment
  const firebaseAccompaniment = firebaseStorage.upload(`${destination}/${filename}/accompaniment.${fileExtension}`, {
    destination: `${filename}/accompaniment.${fileExtension}`,
  })
    .then(() => console.log('Parsed accompaniment uploaded to the firebase storage'));

  // vocals
  const firebaseVocals = firebaseStorage.upload(`${destination}/${filename}/vocals.${fileExtension}`, {
    destination: `${filename}/vocals.${fileExtension}`,
  })
    .then(() => console.log('Parsed vocals uploaded to the firebase storage'));

  // firebaseParsed Promise
  const firebaseParsedPromise = Promise.all([firebaseAccompaniment, firebaseVocals]);

  Promise.any([
    firebaseParsedPromise,
    new Promise(resolve => setTimeout(resolve, REMOVE_FILE_TIMER)),
  ])
    .then(() => {
      fs.unlink(filePath, (err) => {
        if (err) {
          console.log(err);
        }
      });
      fs.rm(path.resolve(destination, `/${filename}`), { recursive: true, force: true }, (err) => {
        if (err) {
          console.log(err);
        }
      });
      console.log(`${filename} has been deleted out of the server!`);
    });

  // add meta-data to firebase realtime db
  const signedUrl = await firebaseStorage.file('1.mp3').getSignedUrl({
    action: 'read',
    expires: Date.now() + REMOVE_FILE_TIMER,
  });

  firebaseFirestore.update({
    music: firebaseAdmin.firestore.FieldValue.arrayUnion({
      uploadTime: Date.now(),
      url: signedUrl[0],
    }),
  })
    .then(data => console.log(data));

  // TODO: create delete of useless fields
  // remove files from firebase
  setTimeout(() => {
    Promise.all([
      firebaseStorage.deleteFiles({ directory: `${filename}` }),
      firebaseStorage.deleteFiles({ prefix: `${filename}.${fileExtension}` }),
      // firebaseDb.child(filename).remove(),
    ])
      .then(() => console.log(`${filename} was deleted from firebase storage`));
  }, REMOVE_FILE_TIMER);

  ctx.body = {
    vocalFilePath: `/static/music/${filename}/vocals.wav`,
    minusFilePath: `/static/music/${filename}/accompaniment.wav`,
  };
};

const getPlaceholders = async ctx => {
  // get info about past tracks
  let existingMusic = fs.readdirSync(path.resolve(__dirname, '../../../dist/static/music'))
    .filter(file => (file.endsWith('.mp3') || file.endsWith('.wav')));

  // push placeholders if there are nothing.
  while (existingMusic.length < 3) {
    existingMusic.push(`/placeholders/${3 - existingMusic.length}.mp3`);
  }
  existingMusic = existingMusic.map(track => `/static/music/${track}`);

  ctx.body = existingMusic;
};

function promiseFromChildProcess(child) {
  return new Promise(((resolve, reject) => {
    child.stdout.on('data', (data) => {
      console.log(`stdout: ${data}`);
    });
    child.stderr.on('data', (data) => {
      console.error(`child log: ${data}`);
    });
    child.on('close', (code) => {
      console.log(`child process exited with code ${code}`);
      if (code !== 0) {
        reject();
      }
    });

    child.on('error', reject);
    child.on('close', resolve);
  }));
}

module.exports = {
  postSplitMusic,
  getPlaceholders,
};
