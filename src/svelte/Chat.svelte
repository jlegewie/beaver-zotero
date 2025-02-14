<script>
  export let title = "Svelte Chat";
  let message = "";

  function sendMessage() {
    alert(`Svelte received: ${message}`);
    message = "";
  }
</script>

<div class="chat-container">
  <h2>{title}</h2>
  <textarea bind:value={message} rows="3"></textarea>
  <button on:click={sendMessage}>Send</button>
</div>

<style>
  .chat-container {
    display: flex;
    flex-direction: column;
    padding: 8px;
  }
  /* .chat-input {
    margin-top: auto;
  } */
</style>
