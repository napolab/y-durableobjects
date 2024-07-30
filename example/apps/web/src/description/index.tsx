import styles from "./styles.module.css";

export const Description = () => {
  return (
    <div className={styles.container}>
      <h1 className={styles.title}>y-durableobjects</h1>
      <p className={styles.text}>
        The <code className={styles.code}>y-durableobjects</code> library is designed to facilitate real-time
        collaboration in Cloudflare Workers environment using Yjs and Durable Objects. It provides a straightforward way
        to integrate Yjs for decentralized, scalable real-time editing features.
      </p>
      <p className={styles.text}>
        GitHub:{" "}
        <a
          href="https://github.com/napolab/y-durableobjects"
          target="_blank"
          rel="noopener noreferrer"
          className={styles.link}
        >
          https://github.com/napolab/y-durableobjects
        </a>
      </p>
      <p className={styles.text}>
        npm:{" "}
        <a
          href="https://www.npmjs.com/package/y-durableobjects"
          target="_blank"
          rel="noopener noreferrer"
          className={styles.link}
        >
          https://www.npmjs.com/package/y-durableobjects
        </a>
      </p>
    </div>
  );
};
