<!-- Generated from packages/sdk/src/method-help.ts. -->

# Author with Method

Below is a complete worked example, including its request, Method, files, and result. Build a Method for the user's request.

# Worked example: Write a daily briefing

## Request recorded in the Method

Turn one prepared day folder into a complete, cited daily briefing. Follow the approved example for writing and layout, and save the briefing with its website.

## Method

```yaml
format: method/3.1
name: Write a daily briefing
goal: Turn one prepared day folder into a complete, cited daily briefing. Follow the approved
  example for writing and layout, and save the briefing with its website.
inputs:
  day:
    type: text
    description: Date of the prepared records, in YYYY-MM-DD form.
  timezone:
    type: text
    description: Timezone for those records, such as America/Chicago.
environment:
  prepared_day:
    type: files
    description: Folder of prepared records for that day. Read-only.
steps:
  open_inputs:
    name: Check the input folders
    in:
      day: inputs.day
      timezone: inputs.timezone
      prepared_day: environment.prepared_day
    do:
      kind: run
      runtime: python
      entrypoint: briefing_check_inputs.py
    out:
      selected_day:
        type: record
        description: Prepared records, date, timezone, and source hash.
        fields:
          folder:
            type: text
            description: Absolute path to the prepared records.
          day:
            type: text
            description: Selected date in YYYY-MM-DD form.
          timezone:
            type: text
            description: Named timezone used to interpret this day.
          start:
            type: text
            description: README path relative to the prepared folder.
          source_digest:
            type: text
            description: Hash of the prepared files at the start of this run.
      example:
        type: record
        description: The approved example and its complete text.
        fields:
          report:
            type: text
            description: Complete approved report.
      session_links:
        type: text
        description: Links to saved social sessions for this day. A link on its own line displays that
          session in the story.
  write_briefing:
    name: Write the briefing
    in:
      selected_day: selected_day
      example: example
      session_links: session_links
    do:
      kind: agent
      model: writer
      prompt: |
        Write the story of {{selected_day.day}} from the records in {{selected_day.folder}}.
        Follow the complete approved report in example.report for writing and detail.
        Return Markdown with source links: [label](source:record-id) or [label](source:record-id#L10-L20).
        Use calculate_activity_times for supported time estimates.
      tools:
        - calculate_activity_times
    out:
      draft:
        type: text
        description: The complete Markdown briefing.
      supporting_files:
        type: list
        items:
          type: file
        description: File references returned by the calculator, or an empty list when none were made.
    check:
      kind: run
      runtime: python
      entrypoint: briefing_validation.py
    reading:
      check_name: Check source links
      check: Check source IDs, passage line numbers, and supporting files.
  render_and_save:
    name: Render and save the briefing
    in:
      selected_day: selected_day
      draft: draft
      supporting_files: supporting_files
    do:
      kind: run
      runtime: python
      entrypoint: briefing_render.py
    out:
      saved_briefing:
        type: file
        description: Saved briefing receipt with its date, timezone, and file paths.
      published_website:
        type: file
        description: Briefing website with source pages and supporting files.
        format: method-website
result:
  briefing: saved_briefing
  website: published_website
run_prompt: Run Write a daily briefing for the requested prepared day folder. Read the date and
  timezone from its records. When finished, open the briefing website and give me the run link.
files:
  - briefing_files.py
  - briefing_times.py
  - briefing_sessions.py
  - briefing_check_inputs.py
  - briefing_artifacts.py
  - briefing_manifest.py
  - briefing_progress.py
  - briefing_validation.py
  - briefing_render.py
  - briefing_website.py
  - briefing_markdown.py
  - reader/reader.css
  - reader/reader.js
  - runtime.json
  - package.json
  - package-lock.json
  - pyproject.toml
  - uv.lock
  - vendor/marked.mjs
  - approved-report.md
```

## Complete approved report

````markdown
---
date: 2026-05-11
timezone: America/Chicago
title: May 11 — proposed briefing
---

# Monday, May 11

_A day in Chicago_

## TL;DR



**You worked on Alpha Research and a French 79 synth recreation, then visited friends.** You had Codex move research jobs to Modal, simplify the prompts, and fix the interface. It reported completing the move, but you still wanted better reports. The music run’s apparent success came from replaying the target recording; a later attempt remained below your goal. [Sources](source:codex-0246,codex-0583,codex-1152,codex-1470,google_timeline-0009)



Between these tasks, you browsed X and Instagram and compared synths in ChatGPT. Your notes asked why you keep polishing work instead of shipping it. You reached your friend's home around 6:45 and returned home around 11:15, ahead of your flight to New York the next day. [Sources](source:browser-0012,instagram-0028,chatgpt-0039,apple_notes-0002,google_timeline-0009,google_timeline-0011,gmail-0004)



**Time estimates:** about 6 h in work sessions (including music), 3 h on X, 50 min on Instagram, 4 h 10 min visiting friends, 1 h 20 min traveling, and 35 min of Spotify playback. These periods overlap. [Sources](source:time-estimates)

## After midnight



At 12:01 AM, you asked Codex to fix Alpha Research’s tool-call error. You also pointed out that an HTML result was too wide and caused horizontal scrolling. After Codex reported a fix for the tool error, you sent the same error again. [Sources](source:codex-0001,codex-0011,codex-0015,codex-0023,codex-0025)



At 12:29, an apartment alert arrived for a listing in Manhattan. [Sources](source:gmail-0033)

## Morning



At 8:18, The RealReal emailed that it had shipped your Giorgio Armani virgin-wool blazer. [Sources](source:calendar-0001,gmail-0026)



At 8:45, you were on X. LindyMan’s case for Chicago was “It's not a very crowded city.” M_R_Runner warned that “Cheap rent and open seats look like lifestyle wins” while asking why the seats had opened up. Around 9:00, you searched for Manhattan household counts, including the count in 1920. [Sources](source:browser-0012,browser-0014,browser-0058,browser-0064)

[Saved social session](sessions.html#social-3d0e17078813)

[Saved social session](sessions.html#social-47a9d16f6bb1)



At 9:41, an Instagram post in your viewing history read, “Visiting every branch of @chicagopubliclibrary! I did not expect this many fish when I walked in the Sulzer Regional Branch..” [Sources](source:instagram-0028)

[Saved social session](sessions.html#social-76dd57595bb2)



The May 10 daily work briefing was saved in a commit under your name at 10:01. You then searched for Schwab’s American Express card and opened its page. [Sources](source:git-0001,browser-0190,browser-0191)

[Saved social session](sessions.html#social-53e7ac5635b7)



At 10:11, you returned to the tool-call failure: “Wym catches and hardcodes bruh what kind of a fix is that ???? Why wouldnt you fix the root cause ? What is the root cause ??” You opened the May 10 work briefing at 10:13. Codex reported changing when it saved the response state. You also objected to the research assistant asking you for details about data it already had. Before it changed the instructions, you said, “before you make any prompting changes , show me exactly what you are going to change to what.” You asked it to include the dataset briefing in the prompt; Codex reported deploying that change. [Sources](source:codex-0030,browser-0202,codex-0046,codex-0034,codex-0050,codex-0065)

[Saved social session](sessions.html#social-77c87d6d2059)



At 10:24, you opened a Domestika link from Instagram. Around 10:30, you opened the Sierra Club’s ProPublica page, Census data, and a New York Census Reporter profile. In the dataset-maintenance thread, you rejected descriptions that only said “ZIP contents”. You wanted the files inspected: “We should unzip it and delete the archive.” The retry had recovered the economics briefing and updated the profile, according to Codex, although an export step had failed. [Sources](source:instagram-0070,browser-0213,browser-0214,browser-0216,codex-0071,codex-0072,codex-0079)



At 10:34, another apartment alert arrived for a listing in Manhattan. [Sources](source:gmail-0017)



At 10:35, a friend asked, “You guys want to come over later to grill  and watch cubs” [Sources](source:imessage-0001) While that invitation sat in the group chat, you asked for Alpha Research’s dashboard to look more like Alpha Book. You wanted a tighter left sidebar, a clear new-chat action, and a separate output panel. Your browser also moved through Mobbin and Stripe’s payment components. [Sources](source:codex-0084,codex-0093,browser-0227,browser-0235)



At 10:45, you asked ChatGPT how to “spin up arbitrary computers running claude code / codex cli with read only access to those files”. You wanted the workers to share roughly one terabyte of research data. You compared Runloop and Modal, along with ways to make the files available to each worker. [Sources](source:chatgpt-0001,chatgpt-0004,chatgpt-0006,chatgpt-0008,chatgpt-0010,chatgpt-0016,chatgpt-0018,chatgpt-0020,chatgpt-0022) The May 4 weekly review was saved under your name at 10:50. [Sources](source:git-0002)

## Late morning

[Saved social session](sessions.html#social-00971d603fa2)



At 11:02, a Tudor Revival renovation caption read, “Carpet. Heavy drapery. Wallpaper everywhere. Every surface trying to be the moment.” A minute later, another post offered “vintage shopping in Chicago!! @moderndrama20 - 40,000 sq ft mid-century modern warehouse”. [Sources](source:instagram-0093,instagram-0103)



At 11:13, you answered the invitation: “Down”. Two minutes later, United sent check-in messages for your flight from Chicago. [Sources](source:imessage-0002,imessage-0003,imessage-0004)



At 11:18, you asked Codex to plan the move from DigitalOcean to Modal, with shared data that workers could read but not change and separate space for each worker’s results. You authorized the work. [Sources](source:codex-0107,codex-0116)

[Saved social session](sessions.html#social-842fe3d7cd62)



At 11:30, you also asked ChatGPT whether a worker could create and publish a Jupyter notebook, adding, “although i guess you wouldnt see the research as it happens.” [Sources](source:chatgpt-0026)



By 11:33, you had signed in to Modal. [Sources](source:codex-0136)

[Saved social session](sessions.html#social-fd930fc0da88)



From about 11:36, you browsed Modal examples, LangChain, LangGraph, Deep Agents, LangSmith, and DSPy. At 11:42, you checked the migration: “Does it work ? Have you tested it ? Is it integrated into the dashboard / backend of the CLI ?” Codex had tested a worker, but had not yet moved the dataset or proved the complete research path. Your reply was “Ok finish everything then.” [Sources](source:browser-0410,browser-0415,browser-0424,browser-0425,browser-0429,browser-0433,codex-0155,codex-0156,codex-0157)



At 11:51, you opened Mole’s Mac-cleaner site and checkout. You opened the May 4 work review a few minutes later. By 11:56, you were back on the dashboard design: the welcome image, sidebar borders, padding, and text still did not match what you wanted. [Sources](source:browser-0499,browser-0502,browser-0536,codex-0175,codex-0185)

## Noon to 2:00 PM

[Saved social session](sessions.html#social-1615d14767de)



At 12:05 PM, Codex reported a successful check against the migrated economics data. You then asked whether it had removed the old DigitalOcean setup. It had not. “Nope. Delete the old digital ocean stuff. I want a full replacement and to remove all mentions of the old path.” At the same time, you caught the welcome image and recent chats loading repeatedly. You asked Codex to clean up the components: “Dont add more states. Clean up the code so its logically sound.” [Sources](source:codex-0194,codex-0197,codex-0198,codex-0200,codex-0195,codex-0208,codex-0212)

[Saved social session](sessions.html#social-648f73983bf6)



By 12:24, Codex reported removing the old DigitalOcean code, compute, volumes, and secrets, and deploying the Modal replacement. A research run then returned something that looked like a plan rather than the work you expected. You asked for the exact runner prompt, a work log in `work.md`, and a finished `report.html`. [Sources](source:codex-0246,codex-0247,codex-0252,codex-0254,codex-0259)

[Saved social session](sessions.html#social-cac62bb5b5c4)

[Saved social session](sessions.html#social-12418be71ee4)



At 12:37, you asked for dataset maintenance to use Modal too, with only the economics dataset retained. Codex later reported making that change. From 12:39, you also began setting up a goal run to recreate the first five seconds of French 79’s “Between the Buttons.” The agent was to keep the written notes fixed and change the synthesizer sound and effects until it exceeded this experiment’s score target of 0.8. Back in Alpha Research, you called for a simpler prompt: “MAKE A SINGLE, SIMPLE PROMPT THAT INSTRUCTS IT TO ITERATE AND UPDATE WORK.MD TO TRACK ITSELF AND STOP WHEN IT WRITES A REPORT.HTML WITH EVERYTHING” [Sources](source:codex-0264,codex-0284,codex-0322,codex-0271,codex-0291,codex-0288)



At 12:47, you received a dog photo captioned “Milo with no hair”. The group then spotted a problem with the evening plan: “There’s no game today methinks”. They moved the gathering toward 6:30, with Catan as another option. [Sources](source:imessage-0006,imessage-0007,imessage-0009,imessage-0011,imessage-0012)

![12:47 PM — “Milo with no hair”](source:imessage-0006)

[Saved social session](sessions.html#social-ac24d7f89e09)

[Saved social session](sessions.html#social-966938fb7c7e)



Around 1:10, you viewed a files SDK; at 1:21, you searched for Pandoc. Between those visits, you checked the research prompt and the missing plan. You found duplicate run boxes and asked for reopened chats to start at the latest message. At 1:22, Codex also clarified that the remote runner used a non-interactive command with `/goal` in its text, not the interactive goal session you had requested. [Sources](source:browser-0814,browser-0837,codex-0334,codex-0344,codex-0352,codex-0362,codex-0374,codex-0376)



At 1:27, you asked why a research run had produced such a strange HTML result. Codex found that the run had a report, but the interface selected an oTree experiment template from its output files. It later reported changing that selection rule. You also had the music goal running and opened Messenger at 1:38. [Sources](source:codex-0380,codex-0387,codex-0425,codex-0388,codex-0401,browser-0883)

[Saved social session](sessions.html#social-e5dae95a4d8a)



A successful music score copied into the chat at 1:41 came from a May 6 run. When you listened, your response was “it still sounds bad.” You named the problems: “you didnt add the right kind of LFO that the real one has. 2. there's a weird quietness thing.” You asked for stricter scoring that would catch them. At 1:46, you opened “The Pig-or-Wig Theory of Populism.” You also asked Alpha Research to display images and PDFs correctly. [Sources](source:codex-0421,codex-0434,codex-0436,codex-0449,browser-0909,codex-0440,codex-0445,codex-0462)

## 2:00–4:00 PM

[Saved social session](sessions.html#social-5f844dc43645)

[Saved social session](sessions.html#social-5cbc4ac32c8c)

[Saved social session](sessions.html#social-5c1027cdf7c5)



At 2:11, you asked where research outputs would remain after a temporary worker stopped. You approved saving them in R2. At 2:20, you posted an X reply to dany and Brian Chesky proposing a “semantic search box”: you would enter “historic property walking distance to french quarter new orleans with parking” and get a grid or map. The point was “the real trick is reasoning over descriptions / images for what's "historic"”. Codex reported adding the R2 storage at 2:21. [Sources](source:codex-0519,codex-0530,x-0001,codex-0573)



At 2:25, you challenged both the testing and the report. It was not ready for your boss and did not read like a real paper. At 2:27, you liked the proposed 6:30 gathering time. Around 2:29, you searched for the sizes of Anna’s Archive and the Internet Archive, and checked how many gigabytes are in a petabyte. [Sources](source:codex-0583,imessage-0015,browser-0995,browser-0999,browser-1001)



At 2:30, you asked ChatGPT, “anna's archive has 63 million books and the internet archive 25 million books is this pretty comprhenesive ?” ChatGPT answered that the collections overlap and that counting books does not establish how much usable text they contain. [Sources](source:chatgpt-0029,chatgpt-0031)



Codex acknowledged that it had initially checked only the R2 configuration; it reported an actual upload, download, and deletion test. You kept asking for the full research prompt. You wanted stronger methods and results, with useful tables and figures, and clearer positive instructions. Codex reported changing it. You also found that reopening a chat could lose the dataset context and that sending a message created a large blank gap. [Sources](source:codex-0603,codex-0617,codex-0628,codex-0643,codex-0633,codex-0672,codex-0686,codex-0648,codex-0671)

[Saved social session](sessions.html#social-4e98d1434ce5)



At 2:48, you asked for easier scrolling, short generated session titles, and a spinner for an active research run. You also wanted wider reports. In the music interface, you wanted to hear each full attempt while the run continued, remove the five-iteration cap, and read plain-English decisions instead of internal labels. [Sources](source:codex-0723,codex-0738,codex-0773,codex-0794)



At 2:51, an Instagram caption said, “Detroit is filling in I-375 and turning it into a regular street.” At 2:53, you liked a post describing “Tempe is starting to feel like the new Miami in its own desert version”. In the group chat at 2:57, your friend proposed hot dogs and corn for the grill. [Sources](source:instagram-0149,instagram-0150,imessage-0017)

[Saved social session](sessions.html#social-c2141cf2f838)



At 3:01, you asked why automations could not reach the web and requested full permissions. You continued checking the research layout and asking the music graph to show what the run was actually doing. At 3:22, you opened OpenAI’s deployment-company announcement and pages about forward-deployed engineers and Tomoro. [Sources](source:codex-0809,codex-0816,codex-0838,codex-0872,codex-0885,browser-1172,browser-1174,browser-1175)

[Saved social session](sessions.html#social-c26012e45e29)



From 3:29, you looked up Tunnel Tops Park, Joost Klein, and Britsum. You also explored Sea Gate and Brighton Beach in Google Maps. An apartment alert arrived at 3:32 for a listing in Manhattan. At 3:40, Cal.com emailed a booking notice for a 30-minute meeting with Taylor Reed. [Sources](source:browser-1202,browser-1210,browser-1212,browser-1233,browser-1332,gmail-0008,gmail-0007)



At 3:43, Codex explained why dataset maintenance had sent no Slack notice: the job no longer attempted the downloads that triggered it. It also reported a profile update failing with HTTP 405. A minute later, Instagram presented a map captioned “Where do Chicagoans have the most friendships?” At 3:47, you caught a music preview playing about half a second instead of five. Codex found that the interface had selected a short diagnostic WAV file. [Sources](source:codex-1056,codex-1066,instagram-0166,codex-1071,codex-1078,codex-1079,codex-1080)

## 4:00–5:45 PM

[Saved social session](sessions.html#social-8b34222ebd56)

[Saved social session](sessions.html#social-72c27f17dfe9)



At 4:21, you wrote, “holy shit it sounds good !” Then, in the same message: “oh wait the score is 1.00 did i cheat ? did it actually produce the midi or did it steal the target audio and insert it in there ???” Codex checked and confirmed it: the winning step loaded the reference clip into a sample player. The near-perfect score was invalid. You replied, “bruh wtf. how do we stop it from doing that ?” [Sources](source:codex-1148,codex-1152,codex-1153)



At 4:23, the group chat returned to food: someone offered to bring chips and salsa and asked for a vegan hot dog. [Sources](source:imessage-0018,imessage-0019)

[Saved social session](sessions.html#social-cf433f777684)



At 4:26, you asked ChatGPT about the production of “Between the Buttons”: “Has anyone made a synth patch of their exact setup ?” It reported finding no confirmed exact patch, but pointed you to a Serum remake. [Sources](source:chatgpt-0032,chatgpt-0034)

[Saved social session](sessions.html#social-0a4ef09614a4)



At 4:29, you opened a video recreating “Between the Buttons” in FL Studio and Serum. You brought ideas about filtered synth sounds, chorus, delay, sidechain movement, and reverb back to Codex. You asked why the agent was drawing odd volume curves. It said the scoring put too much weight on loudness and had rejected some improvements in tone. Your instruction was “Definitiely punish random automation points on volume.” Then you checked another assumption: “We're using Vital as the synth , right ?” It was not; the run used an internal sound generator. [Sources](source:browser-1384,codex-1164,codex-1166,codex-1169,codex-1171)



From 4:39, you searched for the Minimoog, Juno-60, and oscillator stability. At 4:40, you asked ChatGPT, “is it possible to get the sound of a moog model d with vital synth ? just with the right parameters ?” A minute later: “same with the juno ?” Around 4:47, you looked up groceries, Aldi, Jewel-Osco, and Fort Knox Studios in Maps. At 4:48, Codex reported a successful one-second stereo render through the Vital plugin installed on your Mac. It clarified that the other effects were internal approximations, not third-party audio plugins. [Sources](source:browser-1403,browser-1406,browser-1409,browser-1423,browser-1437,browser-1438,browser-1448,codex-1188,codex-1190,chatgpt-0035,chatgpt-0036,chatgpt-0037,chatgpt-0038)

[Saved social session](sessions.html#social-0d0d3ab1dcdc)



You asked about paid plugins, then free alternatives. Your browsing included MicroKorg arpeggiation, ShaperBox, Arturia’s chorus, FabFilter compression, Valhalla Supermassive, PanCake, and DC1A. At 4:54, you asked ChatGPT, “does a free synth like vital sound meaningfully different from a paid synth ? what about effects ?” At 4:57, you decided: “Ok well we have everything on the mac so let's roll with what we got.” You wanted the agent to research the song once, write a guide, and use it throughout the run. At the same time, United’s email listed your May 12 flight from O’Hare to LaGuardia. [Sources](source:codex-1191,codex-1194,browser-1465,browser-1469,browser-1471,browser-1472,browser-1479,browser-1480,browser-1488,codex-1204,gmail-0004,chatgpt-0039,chatgpt-0040)



At 5:01, you corrected the agent when it returned to the old critic-and-producer setup: “We're doing Goal runs , now.” [Sources](source:codex-1214,codex-1216)

[Saved social session](sessions.html#social-85ca58ea6d16)



The music instructions changed to use a clean run folder. [Sources](source:codex-1236)



At 5:14, you were still trying to see the actual instructions: “WHAT ARE THE PROMPTS AHHHHH” Then: “Holy shit simplify this prompt. Much much much more simple.” [Sources](source:codex-1265,codex-1270) In the group chat that minute, another person offered to stop at the Aldi on Milwaukee on the way over. [Sources](source:imessage-0025)



At 5:20, you opened Thinking Machines’ page on interaction models. You then checked whether all three notes in the music chord were playing. Updates were split between run pages, so you asked to stop the old processes and restart with one page. You also flagged unexpected iteration numbers, missing decision logs, and a score absent from the graph. [Sources](source:browser-1597,codex-1294,codex-1301,codex-1318,codex-1322,codex-1349,codex-1359,codex-1375)

## Visiting friends



Maps places you near a transit stop before 6:00; you searched for the station at 6:06. [Sources](source:photos-0001,google_timeline-0003,google_timeline-0004,google_takeout-0325)

![5:46 PM — photo from your library.](source:photos-0001)

[Saved social session](sessions.html#social-e29876567a71)



At 6:07, you asked the group, “Address ?” A friend sent the address. You requested directions to it and also looked up Lola’s Diner 3. At 6:21, you checked whether the music agent was still running. Your route then fits a trip by public transit and a walk toward your friend's home. [Sources](source:imessage-0037,imessage-0038,google_takeout-0330,google_takeout-0326,google_takeout-0328,codex-1425,google_takeout-0333,google_timeline-0007,google_timeline-0008)



Around 6:33 PM, your credit card recorded a $6.66 charge from Aldi. [Sources](source:finance-0002)

[Saved social session](sessions.html#social-676c1ff41c1a)



By about 6:45, Maps places you near your friend's home. Two minutes later, you asked, “Apt num ?” The location record keeps you there until about 10:53. The group had planned grilling and Catan. At 6:50, the background music agent reported a best score of about 0.681, below your 0.8 target, and kept testing. [Sources](source:google_timeline-0009,imessage-0039,imessage-0012,imessage-0017,codex-1470,codex-1473)



Around 7:00, you looked up Los Potrillos and Joong Boo Market. At 7:08, you searched for new Adizero marathon shoes. [Sources](source:google_takeout-0360,google_takeout-0361,browser-1672)

## Evening and the return home



Around 8:25, Google activity records you watching Jaden Williams’s “How we treated AI in 2023 vs 2026.” [Sources](source:google_takeout-0378)

[Saved social session](sessions.html#social-098ec9978304)



At 9:28, someone asked you to let the dog out of his crate because he was crying. At 10:05, you replied, “Im not home”. Around 10:40, you searched for superforecasting, opened Metaculus, and looked up RAND. [Sources](source:imessage-0040,imessage-0041,imessage-0042,browser-1688,browser-1689,browser-1693,browser-1696)



At 10:48 PM, your credit card recorded a $12.73 charge from Lyft. About 12 seconds later, a message said your driver was three minutes away. At 10:51, it said your driver had arrived in a Kia Carnival. Maps records the vehicle trip and your return home around 11:15. [Sources](source:finance-0001,imessage-0043,imessage-0044,google_timeline-0010,google_timeline-0011)



Back home, you returned to X from 11:17 to 11:30. Near the end, you opened Citrini’s profile. [Sources](source:browser-1699,google_takeout-0410,browser-1739,google_takeout-0472,browser-1740,google_takeout-0474)

## Your May 11 notes

[Saved social session](sessions.html#social-42e85fc89a53)



In your Alpha Research note, you wrote: “I have a tough time declaring something done and shipping it. I will polish it for too long (alpha book for 1 month, now alpha research the general platform for 1 month)” Outreach was part of the problem: “I hate I hate cold calling I hate any room where I feel like im begging.” You had tried a launch video, then left it when it did not gain momentum. The note ended, “Anytime I get too deep into top level planning or retrospection I go onto twitter or instagram and that distracts me from it. Because the introspection makes me uncomfortable” [Read passage](source:apple_notes-0002)



You returned to “the introspection makes me uncomfortable”, a phrase your younger self would have mocked. Your question to him was “what would you say instead ?” You wrote: “you read others through the bottleneck of course they are low res . YOU WILL NEVER BE HIGH RES TO ANYONE BUT YOURSELF” [Read passage][language]



Your old model of social media was “There is a collection of facts they sample and present to you. Here is what people think.” Your new account was: “Every possible sentiment is tried as a shower thought. One in a million hits someones fears on the head and gets engagement. The creator gets audience captured into that. Demand driven.” [Read passage][social-media]

## Other records



Spotify saved 15 plays, including repeats and partial plays. [Show all](source:spotify-0001,spotify-0002,spotify-0003,spotify-0004,spotify-0005,spotify-0006,spotify-0007,spotify-0008,spotify-0009,spotify-0010,spotify-0011,spotify-0012,spotify-0013,spotify-0014,spotify-0015)


## Supporting document: time-estimates

# May 11 time estimates

**Work:** First-to-last [Codex and ChatGPT messages](documents.html), split at gaps over 15 minutes. Excludes automated prompts and unattended runs.

**X and Instagram:** First-to-last visits in each [session](sessions.html), split at gaps over five minutes.

**Friends:** [6:45–10:53 PM](source:google_timeline-0009), from Google Maps.

**Travel:** About 56 minutes [outward](source:google_timeline-0003) and 22 minutes [home](source:google_timeline-0010), including stops. Departure time is approximate.

**Spotify:** Sum of the [15 saved playback durations](source:spotify-0001), including partial plays.

Work and browsing periods can include breaks and overlap. They do not measure continuous attention.

[language]: source:roam-0001#L3-L6
[social-media]: source:roam-0001#L7-L8

````

The installed example folder contains the helpers, sample records, recorded sample website, and run instructions in README.md.

Validate with method validate task.method, save with method save task.method, then run the returned version with method run WORKFLOW_ID --version VERSION_ID. Inspect the result and its links.

Use method schema for field definitions, method authoring execution for setup, and method COMMAND --help for command arguments.


# Method concepts

A method has format, name, goal, steps, result, and optional inputs, state, environment, and files.
Each step has either do or ask. purpose, reading, and limits are optional. The do object selects kind: run, call, or agent.
run uses runtime and entrypoint; call uses model and prompt; agent can select browser: environment.NAME and optional custom tools.
Optional run_prompt is plain text for the outside agent that starts a saved Method. Write which Method to run, where to find its inputs, and what to show when finished. Save it with the Method version and update it when inputs or outputs change. The copy button appends the exact version link and shared CLI setup; do not repeat them in run_prompt. This field is not a step prompt and does not expand variables. Set it with method set task.method /run_prompt --text-file run-prompt.txt.

In method/3.1, prompts use {{date}} for the step input declared as in.date. Nested fields such as {{customer.name}} are allowed. Only text, numbers, and booleans can be inserted; pass lists and records as structured inputs. Whitespace inside braces is allowed. Escape a literal placeholder with a backslash before its opening braces (use a YAML block scalar). Values are inserted once, never evaluated or expanded again. Unknown variables, invalid paths, and non-scalar values fail validation. Missing runtime values fail before model execution. Defaults belong in input declarations. Human ask text uses the same scope; agent check prompts use {{inputs.date}} and {{outputs.answer}}. Script commands, labels, and tool descriptions are not templates. Single braces are ordinary text.
Runs record prompt.rendered with the template and expanded instructions for each invocation and phase; the run page shows the recorded expansion, with templates in technical details. Model and agent work uses finite default limits; steps can override them.
An optional step reading object explains inputs, outputs, condition, and check in plain text for the reading page. These descriptions do not alter execution. Describe the declared data and actual checks; keep them in sync when editing the step. The page always shows the exact do and check instructions as well. Give a separate executable check a short reading.check_name, such as “Compare saved text”, and use reading.check to explain what it checks. These fields change presentation only. Older checks without a name display “Check”. Do not imply that a file or reference check verifies facts, or add a check just to fill the display.
Inputs and outputs have a type and an optional description. Types: text, number, boolean, record, list, file. Records need fields; lists need items or fields. Files have path and sha256.
Online runs upload declared file outputs separately, up to 20,000 files and 100 MB total, with 25 MB per file. Hash-checked receipts let interrupted transfers resume with only missing files. The single-file inspect export retains its separate 20 MB compressed-data limit. For a website, declare format: method-website and write a JSON file {schema: "method-website/1", title, entrypoint, files: [{path, sha256, media_type}]}. Paths in the file list are relative to that file; list every asset and identify an HTML start page. The run page opens the website only when all listed assets are attached. It can also download the complete website as a ZIP. No workspace scan occurs. See docs/result-files.md and examples/website-result.method for the full contract and working example. method sync RUN_DIRECTORY uploads files without executing steps again.
Bind step inputs with in aliases and use named outputs as downstream references. These references set execution order. Use after for required order without a data reference, such as operations that share a browser session. Every output has one producer.
Checks use equals, count, present, file, a script, or a bounded agent. Checker output is {status: pass|fail|unknown, reason, evidence}. Unknown never passes.
Use changes for state.NAME or environment.NAME. External changes require a check. State changes commit only after acceptance. State is saved in state.json.
Use each for a collection, repeat for bounded iteration, when for a boolean condition, and after for dependencies. Each and repeat cannot be combined.
Run a single step with repeat: {max_iterations: N, until: BOOLEAN_OUTPUT}. The final accepted output is returned; all iterations are recorded.



For live progress, native Codex forwards public updates as they arrive. Scripts use METHOD_PROGRESS_FD; run method progress --help for the message and child-agent relay protocol. Keep stdout for the final JSON result. Report real milestones without source passages or secrets. Quiet work still sends a five-second heartbeat; the page polls every three seconds. A heartbeat shows the executor is connected, not that new work has completed. See https://github.com/method-ai-hq/method-sdk/blob/main/docs/progress.md for complete examples.

Use reading.output_name to give a returned result a short, honest name. Use reading.outputs to explain its contents.
# Execution setup

Use method run FILE_OR_ID [--config runtime.json] [--workspace HELPERS_FOLDER] [--inputs inputs.json] [--state state.json] [--run-dir DIR].
Explicit named model profiles keep their settings. For an unconfigured profile, Method uses --agent, the configured default, the identified calling agent, or the sole available supported agent. If a choice is needed, use --agent codex or --agent claude. Both use normal sign-in. The selected provider stays fixed on resume.
A simple local-agent Method needs no runtime.json. When needed, put runtime.json beside the Method. New saved versions carry their helpers and runtime.json. Older versions without saved files still need --workspace DIR. --config overrides that file. Relative files-environment paths and executable paths in configuration resolve from the config folder. A bare executable name is found on PATH.
Environment declarations name required connections. An agent with browser: environment.NAME receives the standard direct browser-use controls. Codex or Claude chooses the browser actions. Method opens the selected browser, retains its sign-ins privately, and reuses the session across steps. On macOS, Method copies your last-used Chrome profile and runs headless. Sign in through Chrome before running the Method. Run headless by default. If a task requires a visible browser, show it only for that task, then return to headless mode. Use method browser connect --cdp URL to attach to a Chrome session that permits control. Validation does not open a browser. Each run has a separate profile; resume reads the current page, not a saved web snapshot.
Operator config supplies runtimes, tools, environment, and run limits. Optional models.PROFILE: {backend: codex, model: MODEL} selects a model; omit model to use the Codex default. command can select the Codex executable and reasoning_effort can override its setting.
An explicit models.PROFILE with backend: openai-responses keeps the direct API path. It requires model, api_key_env, and max_output_tokens. Keep key values out of the config; api_key_env names an existing environment variable.
runtimes.PROFILE uses command, version, optional args and env variable names. Scripts and Codex require allow_local_processes: true. They are trusted local processes.
Custom script tools declare description, in, out, run, and effects. List custom tools in the step and config. Browser controls are supplied automatically; interactive controls require changes: [environment.NAME]. Check tools cannot declare external effects.
Defaults: one hour per run, ten minutes per step, 100 model requests, 100 step invocations, 200 tool calls, and 16 MiB for input and output. Step defaults allow 32 agent turns/model requests. Override run limits with timeout_ms, max_model_requests, max_invocations, max_tool_calls, max_output_bytes, max_request_bytes. Method enforces the Codex process timeout, prompt/output size, and declared Method tool-call limit. max_model_requests and max_agent_turns govern the direct API loop only; Codex manages its own internal requests and built-in tools. Codex usage and process logs are saved separately.
Declared tools are exposed to each Codex or Claude step through a temporary local MCP connection. It uses the same script execution and checks as the API path. Codex also retains the user's installed tools. Method does not sandbox these processes. No persistent Codex configuration is edited.
Scripts receive one JSON object on stdin and return one JSON object on stdout. Write artifacts under METHOD_OUTPUT_DIR. State updates are returned under state.
Save includes declared files, script and tool entrypoints, dependency lockfiles, and the runtime release. Run accepts a Method ID or dashboard URL and restores that version. Standard node and python runtimes are prepared automatically. Custom runtime settings stay explicit.
Use method inspect RUN_DIRECTORY --out inspection.json for a saved run; online runs sync to the same Method dashboard.
Use method bind ID NAME --file FOLDER to remember an input on this computer. Add --upload only to save that selected input folder privately in the account. Bundled examples stay in the version; day records stay separate.
Use method state ID --enable --file state.json to opt into shared account state. Concurrent runs cannot overwrite it. Account state is JSON; an uploaded SQLite input is a snapshot, not a shared database. Use a live service connection for a shared database. A stopped run keeps ownership until continued or explicitly released with method state ID --release RUN_ID after inspecting its actions.
CLI runs of local files and saved Methods have their own process. Use --background to return immediately, method run-status DIR, method wait DIR, or method cancel DIR. New runs accept package runtime versions explicitly tested by the installed SDK. The saved package stays unchanged; run records identify the executor used. Resume the same Method version and exact executor with --resume --run-dir DIR. Checkpoints without an executor version need their original SDK/runtime installation. Use method sync DIR to retry uploads without repeating work.


# Recipes

Use a script for exact file transforms and exports. Use a call for a structured model response. A direct API call is one request without tools; the Codex backend controls its own internal requests and tools. Use an agent only when bounded tool use is needed.
For incremental exports, keep a declared state ledger of source IDs and evidence hashes. Compare new evidence to that ledger and rebuild only changed days. Supply the prior run's state.json with --state for a new run.
Resume continues the same input set and saved version. A new run can collect new files. A separate database is optional application state, not a workaround required to resume Method.
To edit a failed method, read its exact saved version and logs, compare the current version, then save the complete repair with a reason.


# Recovery

For a stopped run, read summary.json, events.jsonl, and checkpoint.json. Resume with the original method, config, --run-dir DIR, and --resume. Accepted steps and iterations are reused.
An unfinished action needs --retry STEP:ITERATION after inspection of its external effects. A retry consumes the remaining run budget. Budgets do not reset on resume. Changed methods or config require a new run.
For ask, supply --human FILE containing {steps: {"STEP:ITERATION": {outputs: {NAME: VALUE}}}}. Use the user's actual answer. Checks still run.
For a stale .lock, first confirm the process has stopped. Never remove an active process lock.
State commits after checks. A local checkpoint cannot roll back an external write. Inspect external state before an explicit retry.
For a save conflict, get the latest version and apply the change there. For an uncertain upload, retry the same file and command with its sidecar unchanged.
Use method sync RUN_DIRECTORY to repair a dashboard upload without executing the method again.
Methods use format method/3.1.


# Command reference

Local authoring commands edit draft files. create, save and update publish method versions. run executes a saved version.

Server: https://app.withmethod.ai by default. --server selects another server and its login.
Success exits 0. Errors exit 1 with text on stderr, unless the command specifies another result.

Common errors:
File commands require readable YAML or JSON. Editing commands report draft locks and leave the original file unchanged after a failed edit. Online commands require sign-in and network access. Use method authoring recovery for conflicts and interrupted saves.

## browser connect

Select a private browser connection.

Usage:

```sh
method browser connect [--name NAME] [--cdp URL]
```

Arguments and defaults:
NAME defaults to default. --cdp attaches to a Chrome session that permits remote control. Without --cdp, Method runs headless. On macOS it copies your last-used Chrome profile to reuse sign-ins. Use method-browser:NAME for a named browser binding.

Result and changes:
Saves the browser selection on this computer. No browser is started by this command.

Errors:
Invalid name or endpoint. Credentials must not be in the URL.

Example:

```sh
method browser connect
```

## deploy

Prepare and approve a runner from a successful run, then run it with new inputs.

Usage:

```sh
method deploy --from-run RUN_DIRECTORY
method deploy --approve DEPLOYMENT_ID
method deploy --run DEPLOYMENT_ID [--inputs FILE] [--resume RUN_ID]
method deploy --login DEPLOYMENT_ID [--agent codex|claude]
```

Arguments and defaults:
Preparation uses the selected Method runner and shows its files, inputs, state, and account scope. Approval applies that exact plan and checks access. --run starts a separate business run. --resume continues an existing runner run with the same inputs.

Result and changes:
Prepared review and approval command, or readiness and run command. Missing website sign-ins return a local viewer. Missing agent access returns a runner login command. Both continue the same deployment. Preparation transfers no user data. Session state stays outside the Method package and image.

Errors:
Changed files, missing runner access, unsupported local dependencies, or a writable folder without a shared connection. Missing setup exits 2.

Example:

```sh
method deploy --from-run .method-runs/completed
```

## doctor

Check Node and configured runtime access without running a Method.

Usage:

```sh
method doctor [--config FILE] [--agent codex|claude]
```

Arguments and defaults:
A script-only configuration does not require an agent. Without config, check the selected local agent. Use validate FILE for the Method's own dependencies.

Result and changes:
Setup findings; no task execution.

Errors:
Missing executable, credentials, or provider choice.

Example:

```sh
method doctor --config runtime.json
```

## inspect

Export saved execution evidence.

Usage:

```sh
method inspect RUN_DIRECTORY --out FILE
```

Arguments and defaults:
Use a new output file. --include-files attaches declared result files.

Result and changes:
Saved inspection JSON.

Errors:
Missing run or existing output.

Example:

```sh
method inspect runs/example --out inspection.json
```

## prompt

Read the document as instructions.

Usage:

```sh
method prompt FILE
```

Arguments and defaults:
Current Method file.

Result and changes:
Text; no execution.

Errors:
Invalid document.

Example:

```sh
method prompt task.method
```

## bind

Save a named input location or connection.

Usage:

```sh
method bind ID NAME (--file FOLDER | --connection URL) [--upload]
```

Arguments and defaults:
Default: this computer only. --upload saves only the selected input folder or connection URL in the account. It never scans your disk. Keep credentials in the service's normal sign-in store.

Result and changes:
Saved binding and scope.

Errors:
Missing input, invalid name, or unsafe path.

Example:

```sh
method bind METHOD_ID prepared_day --file day-records --upload
```

## state

Read or explicitly enable shared account state.

Usage:

```sh
method state ID [--enable --file state.json | --release RUN_ID]
```

Arguments and defaults:
Accepted state updates use revision checks. Inspect a stopped run's external actions before releasing its ownership.

Result and changes:
Current revision, value, and owner run.

Errors:
Concurrent ownership or stale revision. Existing state is never silently overwritten.

Example:

```sh
method state METHOD_ID --enable --file initial-state.json
```

## wait

Reconnect to the same local worker.

Usage:

```sh
method wait RUN_DIRECTORY
```

Arguments and defaults:
Use the directory returned by run. Closing this output connection leaves the worker active.

Result and changes:
Live output and final worker status.

Errors:
Stopped process or missing run.

Example:

```sh
method wait .runs/example
```

## run-status

Read worker status without waiting.

Usage:

```sh
method run-status RUN_DIRECTORY
```

Arguments and defaults:
Local run directory.

Result and changes:
Worker status and whether its process is active.

Errors:
Unreadable run directory.

Example:

```sh
method run-status .runs/example
```

## cancel

Stop a local run process.

Usage:

```sh
method cancel RUN_DIRECTORY
```

Arguments and defaults:
Inspect uncertain external actions before any explicit retry.

Result and changes:
Cancellation request. The checkpoint remains available.

Errors:
Unreadable run directory.

Example:

```sh
method cancel .runs/example
```

## progress

Report public progress from a running script or relay a child Codex JSON stream.

Usage:

```sh
method progress --message TEXT [--completed N --total N --unit NAME] [--child NAME]
method progress --codex --child NAME
```

Arguments and defaults:
METHOD_PROGRESS_FD is supplied by the executor. --codex reads JSON lines from stdin; --message sends one message. Do not include secrets or source contents.

Result and changes:
Writes to the separate progress pipe. No stdout output. No-op outside a Method process.

Errors:
Invalid arguments. Malformed Codex events are ignored.

Example:

```sh
method progress --message 'Rendered 12 of 40 pages' --completed 12 --total 40 --unit pages
```

## authoring

Read the installed authoring guide. Available offline.

Usage:

```sh
method authoring [start|concepts|execution|example|recipes|recovery|commands|all]
```

Arguments and defaults:
Default topic: start, including the complete approved Method. Supporting files are installed beside the CLI; their path is printed. all prints the full manual.

Result and changes:
Markdown text on stdout. No changes.

Errors:
Unknown topic: lists the valid topics; exit 1.

Example:

```sh
method authoring all > method-guide.md
```

## init

Create a local YAML draft.

Usage:

```sh
method init FILE --name NAME --goal TEXT
```

Arguments and defaults:
File must be new. Name and goal are required. The draft starts with an empty steps map and result map.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
Missing name or goal; file or sidecar already exists.

Example:

```sh
method init task.method --name 'Find leads' --goal 'Find qualified leads from the specified sources.'
```

## show

Read a draft or one field.

Usage:

```sh
method show FILE [--path POINTER]
```

Arguments and defaults:
Default: the full document. Pointer example: /steps/search/do.

Result and changes:
Selected value as JSON. No changes.

Errors:
The selected field does not exist.

Example:

```sh
method show task.method --path /steps/search
```

## set

Add or replace one draft field.

Usage:

```sh
method set FILE POINTER (--json JSON|--value-file FILE|--text TEXT|--text-file FILE)
```

Arguments and defaults:
Use exactly one: --json JSON, --value-file FILE (YAML or JSON), --text TEXT, --text-file FILE (UTF-8 text). Prefer files for long text. Parents must exist. An empty pointer replaces the document. Escape / as ~1 and ~ as ~0. Nested values replace in full.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
Invalid pointer, missing parent field, or conflicting value flags.

Example:

```sh
method set task.method /steps/search/do/prompt --text-file search.txt
```

## remove

Remove one draft field.

Usage:

```sh
method remove FILE POINTER
```

Arguments and defaults:
The field must exist. Repair remaining references before saving.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
The selected field does not exist.

Example:

```sh
method remove task.method /steps/search/each
```

## step add

Add a complete operation.

Usage:

```sh
method step add FILE --id ID --value-file STEP.yaml
```

Arguments and defaults:
Supply do or ask and the bindings and outputs needed by the step in STEP.yaml. purpose, reading, checks, and limit overrides are optional. Alternatively use --kind run --runtime PROFILE --entrypoint FILE. Agents can use --kind agent --instructions-file FILE; the default is the calling coding agent.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
File commands require readable YAML or JSON. Editing commands report draft locks and leave the original file unchanged after a failed edit. Online commands require sign-in and network access. Use method authoring recovery for conflicts and interrupted saves.

Example:

```sh
method step add task.method --id copy --value-file copy.yaml
```

## step update

Change fields of an existing step.

Usage:

```sh
method step update FILE STEP_ID (--json JSON|--value-file FILE)
```

Arguments and defaults:
Supply an object of fields. Top-level fields merge; nested values replace in full. Use remove to delete a field.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
Unknown step or invalid step fields.

Example:

```sh
method step update task.method search --value-file search.yaml
```

## step remove

Remove an operation.

Usage:

```sh
method step remove FILE STEP_ID
```

Arguments and defaults:
Repair references to its outputs and after constraints before saving.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
The selected step does not exist.

Example:

```sh
method step remove task.method old_search
```

## step move

Change display order.

Usage:

```sh
method step move FILE STEP_ID --before OTHER_ID
```

Arguments and defaults:
Both steps must exist. Data references and after still control execution order.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
The selected step or destination does not exist.

Example:

```sh
method step move task.method search_exa --before search_bookface
```

## check set

Set the operation's independent check.

Usage:

```sh
method check set FILE STEP_ID (--json JSON|--value-file FILE)
```

Arguments and defaults:
Current methods require an equals/count/present/file object, a run check, or an agent check. Put plain-English criteria in an agent check prompt.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
Unknown step, invalid check, or conflicting value flags.

Example:

```sh
method check set task.method search --value-file check.yaml
```

## check remove

Remove the operation's check.

Usage:

```sh
method check remove FILE STEP_ID
```

Arguments and defaults:
The operation will be unchecked. External changes require a check.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
The selected step does not exist.

Example:

```sh
method check remove task.method copy
```

## check

Edit an operation's check.

Usage:

```sh
method check set|remove ...
```

Arguments and defaults:
Use method check set --help for arguments.

Result and changes:
JSON {file, workflow}. The workflow field contains the method. Writes the local draft.

Errors:
Unknown action. Choose set or remove.

Example:

```sh
method check set --help
```

## validate

Check the definition and local setup without running the work.

Usage:

```sh
method validate FILE [--config FILE] [--workspace DIR]
```

Arguments and defaults:
Checks data, names, dependencies, templates, declared files, executables, environment variables, runtime profiles and tool bindings. Defaults to runtime.json beside the Method. --workspace selects the helper folder and default config folder. Relative paths in config resolve from the config folder.

Result and changes:
JSON reports definition, local_setup, executed:false, and valid. Invalid definitions or missing declared files exit 1. Managed setup is reported separately as needs_preparation; run prepares it.

Errors:
The error identifies the invalid field or reference.

Example:

```sh
method validate task.method
```

## diff

Compare two documents.

Usage:

```sh
method diff FILE OTHER_FILE
```

Arguments and defaults:
Both files required. Values are compared after parsing YAML or JSON.

Result and changes:
JSON array of {path,before?,after?}. Empty means equal; exit 0 either way.

Errors:
Both file paths are required.

Example:

```sh
method diff original.method task.method
```

## schema

Read the machine-readable grammar.

Usage:

```sh
method schema [method|config|step|data|environment|check]
```

Arguments and defaults:
Default: method. Use authoring concepts for meaning and authoring recipes for examples.

Result and changes:
JSON Schema for tooling. Data declarations in methods use the six simple types.

Errors:
Unknown schema name.

Example:

```sh
method schema step
```

## create

Save a complete local draft as a new online method.

Usage:

```sh
method create --file FILE [--request-id UUID] [--server URL]
```

Arguments and defaults:
--file required. Request ID defaults to a new UUID and is saved before upload. The draft must not already belong to an online method. Validation runs before upload.

Result and changes:
JSON with workflow_id, version_id, version_number, server and url. Writes FILE.method.json.

Errors:
Invalid method; linked draft; conflicting request ID; pending save with changed contents. See recovery for an uncertain upload.

Example:

```sh
method create --file message.method
```

## get

Read an online method; optionally make a local draft for editing.

Usage:

```sh
method get WORKFLOW_ID [--version VERSION_ID] [--out FILE] [--server URL]
```

Arguments and defaults:
Default: latest version. --out must name a new file with no existing .method.json. Use a version ID to read an exact saved version.

Result and changes:
Without --out: {workflow_id,version_id,version_number,workflow}. With --out: {workflow_id,version_id,version_number,file}; writes the workflow and FILE.method.json.

Errors:
Missing method or version; output file or sidecar already exists.

Example:

```sh
method get wf_example --out edit.method
```

## save

Save a draft as one online version.

Usage:

```sh
method save FILE [--reason TEXT] [--request-id UUID] [--server URL]
```

Arguments and defaults:
New draft: creates a method. Linked draft: --reason required, base version and destination read from FILE.method.json. --request-id is used for first creation; retained pending ID wins on retry. Default server comes from the sidecar, then the online default.

Result and changes:
JSON with workflow_id, version_id, server, url, confirmed:true and document_sha256 after reading back the exact saved version; confirmed saves also include version_number. Updates FILE.method.json. Unchanged draft: unchanged:true, no new version.

Errors:
Invalid method; missing reason; pending changed payload; wrong server; stale base (409). See recovery before retrying.

Example:

```sh
method save edit.method --reason 'Give each output a clear description.'
```

## update

Save a full method against an explicit base version.

Usage:

```sh
method update WORKFLOW_ID --file FILE --base-version VERSION_ID --reason TEXT [--server URL]
```

Arguments and defaults:
All listed non-server arguments required. Prefer get --out and save for normal editing. This lower-level command does not read or update the local sidecar. It validates the whole document.

Result and changes:
JSON {version_id,version_number}. Creates an online version. After success, use get --out NEW_FILE for further edits.

Errors:
Stale base (409); invalid method; missing reason. A repeated update returns the saved version only when parent, contents and reason still match the latest version.

Example:

```sh
method update wf_example --file edit.method --base-version version_example --reason 'Clarify the query.'
```

## status

Check installation and sign-in without listing Methods or starting login.

Usage:

```sh
method status [--server URL]
```

Arguments and defaults:
No required arguments. Checks the selected server with the current credential when one exists.

Result and changes:
JSON {installed:true,server,signed_in}. A missing or expired credential returns signed_in:false. Does not print account details.

Errors:
Network and server errors exit 1; they are not reported as signed out.

Example:

```sh
method status
```

## list

Find your online methods.

Usage:

```sh
method list [--server URL]
```

Arguments and defaults:
No required arguments.

Result and changes:
Server JSON containing methods. No changes.

Example:

```sh
method list
```

## steps

Read all complete step definitions in a saved method.

Usage:

```sh
method steps WORKFLOW_ID [--version VERSION_ID] [--server URL]
```

Arguments and defaults:
Default: latest version. Use step with two IDs to read one saved step.

Result and changes:
JSON {version_id,steps}. No changes.

Errors:
Missing method or version.

Example:

```sh
method steps wf_example
```

## step

Read one online step. For local edits use step add/update/remove/move.

Usage:

```sh
method step WORKFLOW_ID STEP_ID [--version VERSION_ID] [--server URL]
```

Arguments and defaults:
Both IDs required. Default: latest version. Subcommand words add, update, remove, move are reserved for local editing.

Result and changes:
JSON {version_id,step}. No changes.

Errors:
Missing method, version, or step. Use method steps to find step IDs.

Example:

```sh
method step wf_example search
```

## login

Connect this computer with browser approval.

Usage:

```sh
method login [--server URL]
```

Arguments and defaults:
No credentials in chat or command flags. Method opens the sign-in/approval page and waits. Connection is saved per server in ~/.config/method. Sign in again if access expires or is revoked.

Result and changes:
Sign-in instructions and status text. Stores a private local credential after approval. Remote commands also start login when no credential exists.

Errors:
Approval expired, denied, or network unavailable. Repeat login when ready.

Example:

```sh
method login
```

## logout

Disconnect this computer from the selected Method server.

Usage:

```sh
method logout [--server URL]
```

Arguments and defaults:
No required arguments. Select the same server used for login.

Result and changes:
Status text. Revokes remote access, then removes the local credential.

Errors:
If remote revocation fails, the local credential remains. Retry online, or use devices/revoke from another connected computer.

Example:

```sh
method logout
```

## devices

List authorized computers.

Usage:

```sh
method devices [--server URL]
```

Arguments and defaults:
No required arguments.

Result and changes:
Server JSON device list. No changes.

Example:

```sh
method devices
```

## revoke

Revoke a computer's Method access.

Usage:

```sh
method revoke DEVICE_ID [--server URL]
```

Arguments and defaults:
Use the exact ID from method devices. This changes account access.

Result and changes:
Server JSON confirmation. The selected device can no longer use that credential.

Errors:
Unknown device ID.

Example:

```sh
method revoke device_example
```

## runs

Read saved run summaries.

Usage:

```sh
method runs [--method WORKFLOW_ID] [--server URL]
```

Arguments and defaults:
Default: all methods. --method filters the list.

Result and changes:
Server JSON containing runs. No changes.

Example:

```sh
method runs --method wf_example
```

## logs

Read saved run evidence before a repair.

Usage:

```sh
method logs RUN_ID [--server URL]
```

Arguments and defaults:
Use a run ID from method runs. Saved logs may be incomplete if upload failed.

Result and changes:
Server JSON containing the run, inputs, outputs, checks and events. No execution or changes.

Errors:
Missing run.

Example:

```sh
method logs run_example > run.json
```

## sync

Retry upload of records from an existing local run.

Usage:

```sh
method sync RUN_DIRECTORY [--server URL]
```

Arguments and defaults:
Directory must contain method-sync.json. Default destination is the saved run's server. Do not use a new business run to repair an upload.

Result and changes:
Upload status text. Updates dashboard records and local sync metadata. Does not execute steps.

Errors:
Missing run/sync records; access or network error. Keep the original run directory and retry.

Example:

```sh
method sync .method-runs/wf_example/saved-run
```

## run

Execute a saved method locally and upload its run records.

Usage:

```sh
method run WORKFLOW_ID [--version VERSION_ID] [--server URL] [OPTIONS]
```

Arguments and defaults:
Current methods optionally use runtime.json beside a local file, or in the current folder for a saved ID. --workspace selects a different folder. --config FILE overrides the config. See method authoring execution. Optional --state FILE initializes state for a new run. Resume with --resume --run-dir DIR; authorize unfinished work with --retry STEP:ITERATION.

--inputs FILE: JSON input values.
--run-dir DIR: saved run folder.
--agent codex|claude: select an agent for unconfigured profiles in a new run.
--resume: continue the same saved run with its saved agent.
--human FILE: saved human answers for the current runtime.
--verbose: print runtime events.
Use method doctor to check the installed Node and configured tools.

Result and changes:
Progress and final status text; local result.json and run evidence; dashboard run link when synced. The runtime executes the method's declared scripts, calls, agents, and checks. Executes trusted local processes; changes declarations do not enforce permissions. Current runs exit 0 on completion, 1 on failure, and 2 when human input is needed.

Errors:
Missing inputs/access, failed check, timeout, unsafe resume/version mismatch, upload failure. See recovery. Never retry a business write without inspecting its saved changes.

Example:

```sh
method run wf_example --version version_example --config runtime.json --workspace . --inputs inputs.json
```

## Copy a message: syntax reference

```yaml
format: method/3.1
name: Copy a message
goal: Preserve every character of a supplied message.
inputs:
  message:
    type: text
    description: The complete message to preserve.
steps:
  copy:
    purpose: Preserve the exact message.
    in:
      message: inputs.message
    do:
      kind: run
      runtime: node
      entrypoint: copy.cjs
    limits:
      timeout_ms: 10000
    out:
      copied_message:
        type: text
        description: The complete unchanged message.
    check:
      equals:
        actual: copied_message
        expected: message
result: copied_message
```

## Example: build with editing commands

This small syntax example shows the optional editing commands. Use an empty folder.

```sh
set -eu
cat > 'copy.cjs' <<'METHOD_EXAMPLE'
let text="";process.stdin.on("data",x=>text+=x);process.stdin.on("end",()=>console.log(JSON.stringify({copied_message:JSON.parse(text).message})));
METHOD_EXAMPLE

cat > 'inputs.yaml' <<'METHOD_EXAMPLE'
message:
  type: text
  description: The complete message to preserve.
METHOD_EXAMPLE

cat > 'copy.yaml' <<'METHOD_EXAMPLE'
purpose: Preserve the exact message.
in:
  message: inputs.message
do:
  kind: run
  runtime: node
  entrypoint: copy.cjs
limits:
  timeout_ms: 10000
out:
  copied_message:
    type: text
    description: The complete unchanged message.
METHOD_EXAMPLE

cat > 'check.yaml' <<'METHOD_EXAMPLE'
equals:
  actual: copied_message
  expected: message
METHOD_EXAMPLE

cat > 'inputs.json' <<'METHOD_EXAMPLE'
{"message":"Hello"}
METHOD_EXAMPLE

cat > 'runtime.json' <<'METHOD_EXAMPLE'
{
  "allow_local_processes": true,
  "runtimes": {
    "node": {
      "command": "node",
      "version": "22+"
    }
  },
  "limits": {
    "timeout_ms": 60000,
    "max_model_requests": 0,
    "max_invocations": 10,
    "max_tool_calls": 0,
    "max_output_bytes": 1000000,
    "max_request_bytes": 1000000
  }
}
METHOD_EXAMPLE

method 'init' 'message.method' '--name' 'Copy a message' '--goal' 'Preserve every character of a supplied message.'
method 'set' 'message.method' '/inputs' '--value-file' 'inputs.yaml'
method 'step' 'add' 'message.method' '--id' 'copy' '--value-file' 'copy.yaml'
method 'check' 'set' 'message.method' 'copy' '--value-file' 'check.yaml'
method 'set' 'message.method' '/result' '--text' 'copied_message'
method 'validate' 'message.method'
```
