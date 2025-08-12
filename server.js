const express = require('express');
const app = express();
const port = 3000;
const axios = require('axios');
require('dotenv').config();

app.use(express.json());

// Configure axios with retry logic
const axiosRetry = require('axios-retry').default;
axiosRetry(axios, {
  retries: 3,
  retryDelay: (retryCount) => retryCount * 1000,
  retryCondition: (error) => error.response?.status === 504,
});

// In-memory storage for conversation query history (only user queries)
const conversationHistories = new Map();

app.get('/api/stream-pie-chart', async (req, res) => {
  // Set headers for Server-Sent Events
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  try {
    const { messages, conversation_id } = req.query;
    let currentUserMessage = '';
    
    if (messages) {
      const parsedMessages = JSON.parse(messages);
      if (!Array.isArray(parsedMessages) || parsedMessages.length === 0) {
        res.write(`data: ${JSON.stringify({ error: 'No messages provided' })}\n\n`);
        return res.end();
      }
      
      // Get the last user message
      const lastUserMessage = parsedMessages.filter(msg => msg.role === 'user').pop();
      if (!lastUserMessage) {
        res.write(`data: ${JSON.stringify({ error: 'No user message found' })}\n\n`);
        return res.end();
      }
      
      currentUserMessage = lastUserMessage.content;
    }

    // The frontend already formats the message with history, so we use it as-is
    console.log('Received message with context:', currentUserMessage);

    const requestPayload = {
      messages: [{ role: 'user', content: currentUserMessage }],
      conversation_id: conversation_id || crypto.randomUUID(),
      databricks_options: { return_trace: true },
    };

    console.log('Sending message to Databricks:', requestPayload);

    const response = await axios.post(
      'https://dbc-a52503fa-6486.cloud.databricks.com/serving-endpoints/agents_elh_dev-ai_agent-ft_model_v5/invocations',
      requestPayload,
      {
        headers: {
          Authorization: `Bearer ${process.env.DATABRICKS_TOKEN}`,
          'Content-Type': 'application/json',
        },
        responseType: 'stream',
        timeout: 180000,
      }
    );

    let jsonContent = '';
    response.data.on('data', (chunk) => {
      const chunkData = chunk.toString();
      jsonContent += chunkData;

      // Try to parse JSON incrementally
      try {
        const jsonData = JSON.parse(jsonContent);
        if (jsonData.messages && jsonData.messages.length > 0) {
          const lastMessage = jsonData.messages[jsonData.messages.length - 1].content;
          res.write(`data: ${JSON.stringify({ chunk: lastMessage })}\n\n`);
        }
      } catch (e) {
        // Not complete JSON yet, continue accumulating
        res.write(`data: ${JSON.stringify({ chunk: '' })}\n\n`);
      }
    });

    response.data.on('end', () => {
      try {
        const jsonData = JSON.parse(jsonContent);
        let finalContent = 'No response available';
        if (jsonData.messages && jsonData.messages.length > 0) {
          finalContent = jsonData.messages[jsonData.messages.length - 1].content;
        }

        // Check for HTML visualization (for chart responses)
        const pattern = /<!DOCTYPE\s+html>[\s\S]*?<\/html>/i;
        if (pattern.test(finalContent)) {
          console.log('Extracted HTML (first 1000 chars):', finalContent.substring(0, 1000));
          console.log('Extracted HTML length:', finalContent.length);
        } else {
          console.log('No HTML found; using text response:', finalContent);
        }

        res.write(`data: ${JSON.stringify({ html: finalContent, done: true })}\n\n`);
        res.end();
      } catch (error) {
        console.error('Error parsing JSON:', error.message);
        res.write(`data: ${JSON.stringify({ error: `Failed to parse response: ${error.message}` })}\n\n`);
        res.end();
      }
    });

    response.data.on('error', (error) => {
      console.error('Stream error:', error.message);
      res.write(`data: ${JSON.stringify({ error: `Stream error: ${error.message}` })}\n\n`);
      res.end();
    });
  } catch (error) {
    console.error('Error during API call:', error.message, error.response?.data);
    const status = error.response?.status || 500;
    const message = error.response?.status === 504
      ? 'Databricks server timed out. Please try again later.'
      : `API call failed: ${error.message}`;
    res.write(`data: ${JSON.stringify({ error: message })}\n\n`);
    res.end();
  }
});

app.use(express.static('public'));

app.listen(port, () => {
  console.log(`Server running at http://localhost:${port}`);
});